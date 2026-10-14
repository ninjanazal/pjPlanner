---
name: pjplanner-map
description: Analyse the current codebase and build its module diagram in pjPlanner through the pjplanner MCP tools. Use when the user asks to map, diagram, or import this project into pjPlanner.
---

# Map this project into pjPlanner

Build the logical architecture diagram of the project in the current directory, using the `pjplanner` MCP tools. Requires the pjplanner MCP server to be connected with write access (`PJPLANNER_API_KEY`). If the tools are missing, tell the user to install the MCP from pjPlanner's "MCP" button and stop.

## What a module is

A module is a **logical unit of responsibility**, not a file or a class. Aim for 6 to 20 modules however large the project is.

- Good modules: a bounded domain (Billing, Auth), a deployable or layer (API, Worker, Web UI), a significant integration (Payments Gateway), a shared foundation (Database, Shared Types).
- Not modules: single classes, helpers, DTOs, config files, test folders. Fold them into the module that owns them.
- A class becomes a module only when it is a real seam on its own, such as a central orchestrator with many dependants.
- Merge siblings that always change together. Split a module when it holds two unrelated reasons to change.

## Steps

1. **Survey.** Read the README and manifests (package.json, pom.xml, go.mod, pyproject, etc.), list the top-level and `src` directories, and note entry points. Do not read every file; sample imports to understand how directories depend on each other.
2. **Check what exists.** Call `get_graph`. If the diagram already has modules, do not duplicate: reuse matching names, update their descriptions, and only add what is missing. Never delete anything.
3. **Draft the segmentation** and show it to the user as a short list: module name, one-line description, the paths it covers, and its dependencies. Wait for their go-ahead or edits before writing.
4. **Create modules** with `create_module`: `name` (short, domain wording), `description` (what it is responsible for, plus the main paths in the repo), `testStatus` (`full`, `partial` or `none`, judged from test files that cover the module's paths; leave it unset if you did not check) and `testNotes` (framework and where the tests live). Add the module's public surface as `apiItems` (or later with `add_api_items`, which keeps the existing ones) (main endpoints, exported functions, events, types; a handful of the important ones, not everything). `color`, `icon` and the other look fields are optional; set them only when the user asks or the diagram needs distinguishing, for example one color per layer.
5. **Create relations** with `add_relation`: `sourceId` depends on `targetId` (the source imports, calls, or reads from the target). Only direct, meaningful dependencies; skip transitive ones and anything that would create a cycle unless the code truly has one. Use `label` for the nature of the link ("HTTP", "reads", "events") when it adds information.
6. **Report**: modules created or reused, relations added, and anything ambiguous you left out. Suggest the user open the diagram, use Auto layout, and organise groups and owners there.

## Rules

- Do not create issues, sprints, owners, or projects; this skill only maps and updates modules, their relations, and groups. The user creates the project in pjPlanner itself. Only create groups when the user asks for them or approves them in the draft; reuse existing groups (from `get_graph`) before making new ones, and never delete groups. If the tools report that no project exists or is selected, tell the user to create or pick one in pjPlanner and stop.
- To update an existing diagram, use `update_module` for changed descriptions and `remove_relation` only for a relation the code no longer has (show it to the user first). Never delete modules.
- Prefer fewer, clearer modules over exhaustive ones. When unsure, merge.
- Describe modules by what they do, not by the technology.
