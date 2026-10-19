import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, PlannerApi } from "./api.js";
import { dropApiItems, mergeApiItems } from "./apiItems.js";
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
const testStatus = z.enum(["none", "partial", "full"]).nullable().optional().describe("Does the module have automated tests: full, partial, none; null = not assessed");
const testNotes = z.string().optional().describe("Test framework, where the tests live, what is not covered");
const apiItem = z.object({
  id: id.optional().describe("Existing item id to keep and update it; omit for a new item"),
  kind: z.enum(["function", "endpoint", "event", "type", "other"]).optional().describe("Default other"),
  name: z.string().describe("For endpoints start with the HTTP method, e.g. 'GET /api/users'"),
  signature: z.string().optional(),
  description: z.string().optional(),
});
const hex = z.string().nullable().optional();
const look = {
  textColor: hex.describe("Text colour on the card, #rrggbb; null resets to the theme default"),
  strokeColor: hex.describe("Card border colour, #rrggbb; null resets"),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional().describe("Card border style"),
  apiItems: z
    .array(apiItem)
    .optional()
    .describe("The module's public API, REPLACED as a whole: send the complete list (include ids of items to keep). Omitted = unchanged; [] clears all"),
};

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
      state: z.enum(["open", "code_review", "test_validation", "closed"]).optional(),
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

  server.tool(
    "export_project",
    "Export a whole project (owners, groups, modules, relations, sprints, issues) as one JSON object that import_project accepts.",
    { id },
    wrap(({ id }) => api.request("GET", `/projects/${id}/export`)),
  );

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
      groupId: id.nullable().optional(),
      color: hex,
      icon: hex,
      testStatus,
      testNotes,
      ...look,
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
      groupId: id.nullable().optional(),
      color: hex,
      icon: hex,
      testStatus,
      testNotes,
      ...look,
    },
    wrap(async ({ id, ...patch }) => {
      const cur = await api.request<Record<string, unknown>>("GET", `/modules/${id}`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/modules/${id}`, { name: cur.name, description: cur.description, ...Object.fromEntries(defined) });
    }),
  );
  server.tool(
    "add_api_items",
    "Add public API items (endpoints, functions, events, types) to a module without resending the rest. An item with the same kind and name as an existing one updates it; everything else is kept.",
    { moduleId: id, items: z.array(apiItem.omit({ id: true })).min(1) },
    wrap(async ({ moduleId, items }) => {
      const cur = await api.request<Record<string, unknown> & { apiItems: Parameters<typeof mergeApiItems>[0] }>("GET", `/modules/${moduleId}`);
      return api.request("PUT", `/modules/${moduleId}`, { name: cur.name, description: cur.description, apiItems: mergeApiItems(cur.apiItems, items) });
    }),
  );
  server.tool(
    "remove_api_items",
    "Remove API items from a module by id and/or exact name; the other items are kept.",
    { moduleId: id, ids: z.array(id).optional(), names: z.array(z.string()).optional() },
    wrap(async ({ moduleId, ids, names }) => {
      const cur = await api.request<Record<string, unknown> & { apiItems: Parameters<typeof dropApiItems>[0] }>("GET", `/modules/${moduleId}`);
      return api.request("PUT", `/modules/${moduleId}`, { name: cur.name, description: cur.description, apiItems: dropApiItems(cur.apiItems, ids ?? [], names ?? []) });
    }),
  );
  server.tool(
    "create_group",
    "Create a group of modules. Set parentId to nest it under another group (max depth 4). Assign modules to it with create_module/update_module groupId.",
    { name: z.string(), parentId: id.nullable().optional(), color: hex, icon: hex },
    wrap((body) => api.request("POST", "/groups", body)),
  );
  server.tool(
    "update_group",
    "Update a group (rename, recolor, move under another parentId or null for top level); omitted fields keep their value.",
    { id, name: z.string().optional(), parentId: id.nullable().optional(), color: hex, icon: hex },
    wrap(async ({ id, ...patch }) => {
      const groups = await api.request<{ id: number; name: string }[]>("GET", "/groups");
      const cur = groups.find((g) => g.id === id);
      if (!cur) throw new ApiError(`not_found: Group ${id} not found`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/groups/${id}`, { name: cur.name, ...Object.fromEntries(defined) });
    }),
  );
  server.tool(
    "add_relation",
    "Add a dependency: sourceId depends on targetId.",
    { sourceId: id, targetId: id, label: z.string().optional(), color: hex },
    wrap((body) => api.request("POST", "/relations", body)),
  );
  server.tool(
    "update_relation",
    "Change a relation's label and/or color (null clears the color); omitted fields keep their value. At least one is required.",
    { id, label: z.string().optional(), color: hex },
    wrap(({ id, ...patch }) => api.request("PUT", `/relations/${id}`, patch)),
  );
  server.tool("remove_relation", "Delete a relation by id.", { id }, wrap(async ({ id }) => {
    await api.request("DELETE", `/relations/${id}`);
    return { deleted: id };
  }));
  server.tool(
    "create_issue",
    "Create an issue. Hierarchy: epic has no parent; a story's or bug's parent is an epic; a task's parent is an epic, a story or a bug. Only epics, stories and bugs can have children. A task must have a moduleId (exactly one module, required on create; it cannot be cleared later). Only tasks take an ownerId or moduleId, and the ownerId must be one of the moduleId module's owners (so set the module first); epics, stories and bugs reject both (they touch the modules of their tasks).",
    {
      type: z.enum(["epic", "story", "bug", "task"]),
      title: z.string(),
      description: z.string().optional(),
      implementation: z.string().optional().describe("How-to notes for the developer picking the task up: approach, files to touch, pitfalls, links (tasks only; omitted on update = unchanged)"),
      parentId: id.nullable().optional(),
      ownerId: id.nullable().optional(),
      moduleId: id.nullable().optional(),
      sprintId: id.nullable().optional(),
      estimate: z.number().int().min(1).max(99).nullable().optional().describe("Task size in steps, planning-poker style: 1 super easy, 2 easy, 3 small, 5 medium, 8 hard, 10 super hard (tasks only; unset = 1); drives get_sprint_timeline"),
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
      implementation: z.string().optional().describe("How-to notes for the developer picking the task up: approach, files to touch, pitfalls, links (tasks only; omitted on update = unchanged)"),
      parentId: id.nullable().optional(),
      ownerId: id.nullable().optional(),
      moduleId: id.nullable().optional(),
      state: z.enum(["open", "code_review", "test_validation", "closed"]).optional(),
      sprintId: id.nullable().optional().describe("Sprint to put the issue in; null = backlog; omitted = unchanged"),
      estimate: z.number().int().min(1).max(99).nullable().optional().describe("Task size in steps, planning-poker style: 1 super easy, 2 easy, 3 small, 5 medium, 8 hard, 10 super hard (tasks only; unset = 1); drives get_sprint_timeline"),
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
    "Give every unassigned open task of a sprint an owner: all tasks of one story or bug go to one person, preferring whoever closed the most tasks in those modules and balancing the workload. reset=true first clears the owners of open tasks and re-deals them with some randomness, so repeating it gives another split.",
    { id, reset: z.boolean().optional() },
    wrap(({ id, reset }) => api.request("POST", `/sprints/${id}/assign${reset ? "?reset=1&shuffle=1" : ""}`)),
  );
  server.tool(
    "clear_sprint_owners",
    "Remove the owner from every open (not yet started) task of a sprint, to start the distribution over.",
    { id },
    wrap(({ id }) => api.request("POST", `/sprints/${id}/unassign`)),
  );

  const del = (name: string, what: string, path: string, note = "") =>
    server.tool(name, `Delete ${what} by id.${note ? " " + note : ""} Irreversible.`, { id }, wrap(async ({ id }) => {
      await api.request("DELETE", `/${path}/${id}`);
      return { deleted: id };
    }));
  del("delete_module", "a module", "modules", "Its relations and API items go with it; issues keep existing but lose the module.");
  del("delete_group", "a group", "groups", "Child groups move up one level and its modules become ungrouped.");
  del("delete_issue", "an issue", "issues");
  del("delete_sprint", "a sprint", "sprints");
  del("delete_owner", "an owner", "owners");
  del("delete_project", "a whole project with all its modules, owners, groups, issues and sprints", "projects");

  server.tool(
    "set_module_position",
    "Place a module on the diagram canvas (x, y in pixels).",
    { id, x: z.number(), y: z.number() },
    wrap(({ id, ...pos }) => api.request("PUT", `/modules/${id}/position`, pos)),
  );
  server.tool(
    "set_module_positions",
    "Place many modules on the canvas in one call (1-500).",
    { positions: z.array(z.object({ id, x: z.number(), y: z.number() })).min(1).max(500) },
    wrap((body) => api.request("PUT", "/modules/positions", body)),
  );

  server.tool(
    "create_owner",
    "Create an owner (a person or team that can own modules and tasks).",
    { name: z.string(), color: hex, icon: hex },
    wrap((body) => api.request("POST", "/owners", body)),
  );
  server.tool(
    "update_owner",
    "Update an owner; omitted fields keep their value.",
    { id, name: z.string().optional(), color: hex, icon: hex },
    wrap(async ({ id, ...patch }) => {
      const owners = await api.request<{ id: number; name: string }[]>("GET", "/owners");
      const cur = owners.find((o) => o.id === id);
      if (!cur) throw new ApiError(`not_found: Owner ${id} not found`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/owners/${id}`, { name: cur.name, ...Object.fromEntries(defined) });
    }),
  );

  server.tool(
    "assign_issue",
    "Give one unfinished task in a sprint the best owner from its module's owners (balanced). Needs the sprint and module set, and the module to have owners.",
    { id },
    wrap(({ id }) => api.request("POST", `/issues/${id}/assign`)),
  );

  server.tool(
    "update_project",
    "Rename a project or change its description; omitted fields keep their value.",
    { id, name: z.string().optional(), description: z.string().optional() },
    wrap(async ({ id, ...patch }) => {
      const c = await api.request<Record<string, unknown>>("GET", `/projects/${id}`);
      const defined = Object.entries(patch).filter(([, v]) => v !== undefined);
      return api.request("PUT", `/projects/${id}`, { name: c.name, description: c.description, ...Object.fromEntries(defined) });
    }),
  );
  server.tool(
    "import_project",
    "Import a project from export_project JSON. Always creates a new project (name gets \" (2)\" on a clash); nothing existing is touched.",
    { data: z.record(z.unknown()).describe("The full object returned by export_project") },
    wrap(({ data }) => api.request("POST", "/projects/import", data)),
  );
}
