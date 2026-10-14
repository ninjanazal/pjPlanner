---
name: pjplanner-breakdown
description: Break a pjPlanner epic, story or bug into well-segmented tasks through the pjplanner MCP tools. Use when the user asks to break down, split, plan or create tasks for a story or epic.
---

# Break an issue down into tasks

Turn one epic, story or bug in pjPlanner into a small set of tasks, each tied to the module it changes. Requires the pjplanner MCP server with write access (`PJPLANNER_API_KEY`). If the tools are missing, tell the user to install the MCP from pjPlanner's "MCP" button and stop.

## Steps

1. **Pick the parent.** Use the issue the user names (id or title). Otherwise call `list_issues` for open epics, stories and bugs, and ask which one. Call `get_issue` for its description and any tasks that already exist under it. Never duplicate, rewrite or delete existing tasks; propose only what is missing.
2. **Understand it.** Read the issue text, call `get_graph` (modules, owners, relations, test status, API items), and skim the repository code the issue touches. Use `find_dependencies` with `downstream` on each likely module to see what else a change can break.
3. **Ask questions.** One focused round, only about what you cannot work out: unclear scope, acceptance criteria, what is out of scope, constraints, preferred owners or sprint. Use the question tool when you have it, otherwise a short numbered list. Skip this step when the issue is already clear.
4. **Propose the modules.** List the modules that need to change, each with the reason, plus modules that depend on them and may be affected. Let the user add or remove modules before you go on. If the work needs a module that does not exist, say so and point to `/pjplanner-map`; this skill does not create modules.
5. **Segment into tasks.**
   - One task changes exactly one module (pjPlanner requires it). Split by module first, then by independent deliverable inside a module.
   - A task is small enough for one person to finish in a few days. Split anything estimated above 8.
   - Title starts with a verb and names the result ("Expose GET /orders endpoint"). Description says what and how to check it is done. `implementation` holds the approach, files to touch and pitfalls.
   - `estimate` uses the planning-poker steps: 1 super easy, 2 easy, 3 small, 5 medium, 8 hard, 10 super hard.
   - Order tasks along the relations: work in a module that others depend on comes first. Note which task each one waits for.
   - Add a test task only when the story changes a module whose `testStatus` is `none` or `partial`.
   - Aim for 3 to 10 tasks. Prefer fewer, clearer tasks.
6. **Show the draft.** A table with title, module, estimate, waits for, and suggested owner (only owners of that module). Wait for the user's go-ahead or edits before writing anything.
7. **Create.** For each task call `create_issue` with `type: "task"`, `parentId`, `moduleId`, `description`, `implementation` and `estimate`. Set `ownerId` or `sprintId` only when the user asked for it. Report the created ids, the total estimate and anything you left out; with a sprint, call `get_sprint_timeline` and share the suggested order.

## Rules

- Create tasks only. No epics, stories, bugs, modules, owners, sprints or projects unless the user asks.
- Never delete issues, and never edit existing ones without showing the change first.
- Describe work by what changes, not by the technology.
- If the tools report that no project exists or is selected, tell the user to create or pick one in pjPlanner and stop.
