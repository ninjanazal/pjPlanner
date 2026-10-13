import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, PlannerApi } from "./api.js";
import { findDependencies, Relation } from "./deps.js";
import { sprintView, SprintIssue } from "./sprint.js";
import { buildTimeline } from "./timeline.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      if (e instanceof ApiError || e instanceof TypeError) {
        return { isError: true, content: [{ type: "text" as const, text: e.message }] };
      }
      throw e;
    }
  };

const id = z.number().int();
const hex = z.string().nullable().optional();

export function registerTools(server: McpServer, api: PlannerApi, opts: { write: boolean }) {
  server.tool(
    "list_projects",
    "All projects on this server (id, name, counts). The other tools act on the project set by PJPLANNER_PROJECT, or the oldest project when unset.",
    {},
    wrap(() => api.request("GET", "/projects")),
  );
  server.tool(
    "get_graph",
    "Whole plan in one call: modules (with owners, groups, API items), owners, relations, groups. A relation source -> target means source depends on target.",
    {},
    wrap(() => api.request("GET", "/graph")),
  );
  server.tool("get_module", "One module by id.", { id }, wrap(({ id }) => api.request("GET", `/modules/${id}`)));
  server.tool(
    "find_dependencies",
    "Transitive module ids a module depends on (upstream) or that depend on it (downstream; use this for impact analysis).",
    { moduleId: id, direction: z.enum(["upstream", "downstream"]) },
    wrap(async ({ moduleId, direction }) => {
      const g = await api.request<{ relations: Relation[] }>("GET", "/graph");
      return { moduleId, direction, moduleIds: findDependencies(g.relations, moduleId, direction) };
    }),
  );
  server.tool(
    "list_issues",
    "List issues (epic/story/bug/task). Optional filters applied client-side.",
    {
      state: z.enum(["open", "closed"]).optional(),
      moduleId: id.optional(),
      ownerId: id.optional(),
      sprintId: id.optional().describe("Only issues in this sprint"),
      backlog: z.boolean().optional().describe("true = only work not in any sprint (epics are never in a sprint)"),
    },
    wrap(async ({ state, moduleId, ownerId, sprintId, backlog }) => {
      const all = await api.request<Array<{ state: string; rollupModuleIds: number[]; ownerId: number | null; sprintId: number | null; type: string }>>(
        "GET",
        "/issues",
      );
      return all.filter(
        (i) =>
          (!state || i.state === state) &&
          (moduleId === undefined || i.rollupModuleIds.includes(moduleId)) &&
          (ownerId === undefined || i.ownerId === ownerId) &&
          (sprintId === undefined || i.sprintId === sprintId) &&
          (!backlog || (i.sprintId === null && i.type !== "epic")),
      );
    }),
  );
  server.tool("list_sprints", "All sprints (planned, active, closed) with open/closed issue counts. Only one sprint is active at a time.", {}, wrap(() => api.request("GET", "/sprints")));
  server.tool(
    "get_sprint",
    "A sprint with its issues grouped by module and by owner (with open counts): where the work is, in which modules, and who owns it. Omit id for the active sprint.",
    { id: id.optional() },
    wrap(async ({ id }) => {
      const sprints = await api.request<Array<{ id: number; state: string }>>("GET", "/sprints");
      const sprint = id === undefined ? sprints.find((s) => s.state === "active") : sprints.find((s) => s.id === id);
      if (!sprint) return { error: id === undefined ? "No active sprint" : `Sprint ${id} not found` };
      const [issues, graph] = await Promise.all([
        api.request<SprintIssue[]>("GET", "/issues"),
        api.request<{ modules: { id: number; name: string }[]; owners: { id: number; name: string }[] }>("GET", "/graph"),
      ]);
      return sprintView(sprint, issues, graph.modules, graph.owners);
    }),
  );
  server.tool(
    "get_sprint_timeline",
    "Optimal work order for a sprint (default: the active one). Each open task takes its estimate in steps (1 if unset); a task waits for the open tasks of every module its module depends on (relation source -> target = source depends on target); each owner does one task at a time. Returns per-owner lanes with start step and length, which task each waits for, the total length in steps, and how many steps dependencies cost versus the busiest owner working alone.",
    { id: id.optional() },
    wrap(async ({ id }) => {
      const sprints = await api.request<Array<{ id: number; name: string; state: string }>>("GET", "/sprints");
      const sprint = id === undefined ? sprints.find((s) => s.state === "active") : sprints.find((s) => s.id === id);
      if (!sprint) return { error: id === undefined ? "No active sprint" : `Sprint ${id} not found` };
      const [issues, graph] = await Promise.all([
        api.request<Array<{ id: number; type: string; title: string; state: string; ownerId: number | null; moduleId: number | null; sprintId: number | null; estimate?: number | null }>>("GET", "/issues"),
        api.request<{ modules: { id: number; name: string }[]; owners: { id: number; name: string }[]; relations: { sourceId: number; targetId: number }[] }>("GET", "/graph"),
      ]);
      const tasks = issues.filter((i) => i.type === "task" && i.sprintId === sprint.id);
      const tl = buildTimeline(tasks, graph.modules, graph.relations);
      return {
        sprint: sprint.name,
        steps: tl.length,
        stepsLostToDependencies: tl.length - tl.idealLength,
        lanes: tl.lanes.map((lane) => ({
          owner: lane === null ? null : (graph.owners.find((o) => o.id === lane)?.name ?? lane),
          tasks: tl.slots
            .filter((s) => s.lane === lane)
            .sort((a, b) => a.start - b.start)
            .map((s) => ({
              id: s.issue.id, title: s.issue.title, module: graph.modules.find((m) => m.id === s.issue.moduleId)?.name ?? null,
              startStep: s.start + 1, endStep: s.start + s.length, waitsForTaskIds: s.waitsFor,
            })),
        })),
      };
    }),
  );
  server.tool("get_issue", "One issue by id.", { id }, wrap(({ id }) => api.request("GET", `/issues/${id}`)));

  if (!opts.write) return;

  server.tool(
    "create_project",
    "Create a project (a separate workspace of modules, owners, issues and sprints). Returns its id: set PJPLANNER_PROJECT to that id to work inside it.",
    { name: z.string(), description: z.string().optional() },
    wrap((body) => api.request("POST", "/projects", body)),
  );
  server.tool(
    "create_module",
    "Create a module.",
    {
      name: z.string(),
      description: z.string().optional(),
      ownerIds: z.array(id).optional(),
      groupId: id.nullable().optional(),
      color: hex,
      icon: hex,
    },
    wrap((body) => api.request("POST", "/modules", body)),
  );
  server.tool(
    "update_module",
    "Update a module; omitted fields keep their value.",
    {
      id,
      name: z.string().optional(),
      description: z.string().optional(),
      ownerIds: z.array(id).optional(),
      groupId: id.nullable().optional(),
      color: hex,
      icon: hex,
    },
    wrap(async ({ id, ...patch }) => {
      const cur = await api.request<Record<string, unknown>>("GET", `/modules/${id}`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/modules/${id}`, { name: cur.name, description: cur.description, ownerIds: cur.ownerIds, ...Object.fromEntries(defined) });
    }),
  );
  server.tool(
    "add_relation",
    "Add a dependency: sourceId depends on targetId.",
    { sourceId: id, targetId: id, label: z.string().optional() },
    wrap((body) => api.request("POST", "/relations", body)),
  );
  server.tool("remove_relation", "Delete a relation by id.", { id }, wrap(async ({ id }) => {
    await api.request("DELETE", `/relations/${id}`);
    return { deleted: id };
  }));
  server.tool(
    "create_issue",
    "Create an issue. Hierarchy: epic has no parent; a story's or bug's parent is an epic; a task's parent is an epic, a story or a bug. Only epics, stories and bugs can have children. Only tasks take an ownerId or moduleId, and the ownerId must be one of the moduleId module's owners (so set the module first); epics, stories and bugs reject both (they touch the modules of their tasks).",
    {
      type: z.enum(["epic", "story", "bug", "task"]),
      title: z.string(),
      description: z.string().optional(),
      parentId: id.nullable().optional(),
      ownerId: id.nullable().optional(),
      moduleId: id.nullable().optional(),
      sprintId: id.nullable().optional(),
      estimate: z.number().int().min(1).max(99).nullable().optional().describe("Task effort in whole steps (tasks only; unset = 1); drives get_sprint_timeline"),
    },
    wrap((body) => api.request("POST", "/issues", body)),
  );
  server.tool(
    "update_issue",
    "Update an issue; omitted fields keep their current value (merged client-side, since the API's PUT is a full update).",
    {
      id,
      type: z.enum(["epic", "story", "bug", "task"]).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      parentId: id.nullable().optional(),
      ownerId: id.nullable().optional(),
      moduleId: id.nullable().optional(),
      state: z.enum(["open", "closed"]).optional(),
      sprintId: id.nullable().optional().describe("Sprint to put the issue in; null = backlog; omitted = unchanged"),
      estimate: z.number().int().min(1).max(99).nullable().optional().describe("Task effort in whole steps (tasks only; unset = 1); drives get_sprint_timeline"),
    },
    wrap(async ({ id, ...patch }) => {
      const c = await api.request<Record<string, unknown>>("GET", `/issues/${id}`);
      const body = {
        type: c.type,
        title: c.title,
        description: c.description,
        parentId: c.parentId,
        ownerId: c.ownerId,
        moduleId: c.moduleId,
        state: c.state,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      };
      return api.request("PUT", `/issues/${id}`, body);
    }),
  );
  server.tool(
    "create_sprint",
    "Create a sprint (state planned, or active if none is active). Sprints have no dates; they are opened and closed manually.",
    { name: z.string(), goal: z.string().optional(), state: z.enum(["planned", "active"]).optional() },
    wrap((body) => api.request("POST", "/sprints", body)),
  );
  server.tool(
    "update_sprint",
    "Edit a sprint, start it (state=active, only if no other is active) or close it (state=closed: its unfinished issues return to the backlog; irreversible). Omitted fields keep their value.",
    {
      id,
      name: z.string().optional(),
      goal: z.string().optional(),
      state: z.enum(["planned", "active", "closed"]).optional(),
    },
    wrap(async ({ id, ...patch }) => {
      const c = await api.request<Record<string, unknown>>("GET", `/sprints/${id}`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/sprints/${id}`, {
        name: c.name, goal: c.goal, ...Object.fromEntries(defined),
      });
    }),
  );
  server.tool(
    "auto_assign_sprint",
    "Give every unassigned open task of a sprint the best owner from its module's owners (balanced). reset=true first clears the owners of open tasks and re-deals them.",
    { id, reset: z.boolean().optional() },
    wrap(({ id, reset }) => api.request("POST", `/sprints/${id}/assign${reset ? "?reset=1" : ""}`)),
  );
}
