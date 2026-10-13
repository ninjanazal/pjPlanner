# pjPlanner

Project planning tool for tracking modules, their owners, and the relations (dependencies) between modules, with a graph view. Node 22 + TypeScript + Fastify + SQLite backend, Vite + React frontend.

## Run with Docker

```bash
docker compose up --build
```

Open http://localhost:3030. Data is stored in the `pjplanner-data` volume (`/data/pjplanner.db`).

## Local development

Needs Node 22+. `make install` downloads a private copy into `.tools/node` if your system has none (no sudo), and the other `make` targets use it automatically. Without make, install Node 22 yourself.

Backend (port 3030):

```bash
cd backend
npm install
npm run dev     # or: npm run build && npm start
```

Frontend (Vite dev server):

```bash
cd frontend
npm install
npm run dev
npm run build   # outputs frontend/dist
```

Settings live in `.env` at the repo root (`make env` creates it from `.env.example`; `make install` and `make up` do it too): `PORT` (default 3030) and `WRITE_KEY` (required; the server refuses to start without it). Docker Compose and the Vite dev proxy read the same file. Other backend env vars: `DB_PATH` (SQLite file), `STATIC_DIR` (default `../frontend/dist`).

## Layout

- `backend/` - Fastify API, SQLite via better-sqlite3; serves the built frontend
- `frontend/` - Vite + React UI
- `mcp/` - MCP server (stdio) so AI agents can read/update the plan via the REST API
- `Dockerfile`, `docker-compose.yml` - multi-stage image, single `app` service

## API

All under `/api`:

- `GET /api/health` - liveness check
- `/api/projects` - `GET` (list), `POST` `{name, description?}`, `GET /:id`, `PUT /:id`, `DELETE /:id`. Project = `{id, name, description, createdAt, moduleCount, issueCount, sprintCount}`; names are unique case-insensitively (`409`); deleting removes everything in it (any project can be deleted). **All other data routes are scoped to one project**, chosen per request by the `x-project: <id>` header (or `?project=<id>`); without it the oldest project is used, an unknown id -> `404`. A fresh database has **no project**: data routes answer `404` with code `no_project` until one is created. Databases from before projects existed are migrated into one project named `My project`
- `GET /api/projects/:id/export` - downloads `<name>.pjplanner.json` (`{format: "pjplanner-project", version: 1, project, owners, groups, modules, relations, sprints, issues}`). `POST /api/projects/import` takes that JSON as the body and always creates a **new** project (a name clash becomes `Name (2)`), remapping every id; an invalid file -> `400` and nothing is created
- `/api/modules` - `GET` (list), `POST`, `GET /:id`, `PUT /:id`, `DELETE /:id`. Body: `{name, description?, ownerIds?, color?, textColor?, strokeColor?, strokeStyle?, icon?, apiItems?}` (a legacy `status` field is accepted and ignored); see "Module color, icon and API items" below. Modules also carry `x`/`y` (canvas position, `number|null`, `null` = not placed yet); POST/PUT ignore them
- `PUT /api/modules/:id/position` - body `{x, y}` (finite numbers, abs <= 1e6, else `400` `validation_error`); returns the updated Module, `404` for an unknown id
- `/api/owners` - `GET` (list), `POST`, `PUT /:id`, `DELETE /:id` (no `GET /:id`). Owner = `{id, name, color, icon}`; body `{name, color?, icon?}`. `name` is required (trimmed, max 200) and unique case-insensitively (another owner with it -> `409`); `color`/`icon` follow the module rules (`"#rrggbb"` or `null`; 1-8 character emoji or `null`). On `PUT`, omitted `color`/`icon` keep their value and `null` clears; a sent `email` is ignored. Existing databases are migrated at startup (the old `email` column is dropped)
- `/api/relations` - `GET` (list), `POST` `{sourceId, targetId, label?, color?}`, `PUT /:id` `{label?, color?}` (omitted = unchanged, `null` clears, at least one required, else 400), `DELETE /:id` (no `GET /:id`)
- Relations are `{id, sourceId, targetId, label, color}`; `color` is `#rrggbb` (lowercased) or `null` for the theme default arrow colour.
- `/api/groups` (topics that group modules) - `GET` (list), `POST`, `PUT /:id`, `DELETE /:id` (no `GET /:id`). Group = `{id, name, color, icon, parentId}` (`parentId`: `number|null`); body `{name, color?, icon?, parentId?}` with the same rules as owners (name required, trimmed, max 200, case-insensitively unique -> `409`; `PUT` omitted `color`/`icon` unchanged, `null` clears). `parentId` nests groups: `POST` omitted = top level, `PUT` omitted = unchanged, `null` clears; an unknown or non-integer id, the group's own id, one of its descendants (cycle), or a result nested deeper than 4 levels (counting the moved group's own subtree) -> `400` `validation_error`. Deleting a group returns `204`, its child groups move up to the deleted group's parent (or become top level), and its modules become ungrouped (`groupId: null`); modules are never deleted
- Modules carry `groupId` (`number|null`, at most one group). `POST`/`PUT /api/modules` accept optional `groupId`: omitted = unchanged (`null` on create), `null` clears, an unknown group id -> `400` `validation_error`
- `PUT /api/modules/positions` `{positions: [{id, x, y}, ...]}` - batch position update: 1-500 entries, unique existing ids, `x`/`y` finite with abs <= 1e6; atomic (any invalid entry -> `400` `validation_error`, nothing changes); `200` with the updated modules. `PUT /api/modules/:id/position` is unchanged
- `/api/issues` (issue tracker) - `GET` (list), `POST`, `GET /:id`, `PUT /:id`, `DELETE /:id`. Issue = `{id, type, title, description, parentId, ownerId, moduleId, state, childIds, rollupModuleIds}`: `type` is `epic|story|bug|task`, `state` is `open|closed`, `parentId`/`ownerId`/`moduleId` are `number|null` (an issue links to at most one module), `childIds` is sorted, `rollupModuleIds` is the issue's own module plus all descendants' modules (sorted, deduped). Body `{type, title, description?, parentId?, ownerId?, moduleId?, state?}`; `PUT` is a full update (omitted optional fields reset to `null`/`''`/`open`). `title` is required (trimmed). Hierarchy: an epic has no parent; a story and a bug have no parent or an epic; a task has no parent or an epic, a story or a bug; nothing sits under a task; no cycles; a type change must stay valid for both the current parent and current children -> `400` `validation_error`. Only tasks carry `moduleId`/`ownerId`/`sprintId`; epics, stories and bugs only group (the assignee must own the task's module). Unknown parent/owner/module -> `404`; unknown type/state or a non-integer id field -> `400`. Deleting an issue returns `204` and its children get `parentId: null`. Deleting a module or owner sets `moduleId`/`ownerId` to `null` on its issues
- `/api/sprints` (one sprint at a time is active) - `GET` (list), `POST`, `GET /:id`, `PUT /:id`, `DELETE /:id`. Sprint = `{id, name, goal, state, issueIds, openCount, closedCount}`; `state` is `planned|active|closed`. Body `{name, goal?, state?}`; sprints have no dates, they are started and closed by hand. Starting a sprint (`state: "active"`) while another is active -> `409`; a closed sprint cannot be reopened, an active one cannot go back to planned. Closing moves the sprint's *open* issues back to the backlog (`sprintId: null`); closed issues stay as its history. Deleting a sprint returns `204` and its issues return to the backlog
- Tasks carry an optional `estimate` (whole steps, 1-99; `null` = 1): omitted on `PUT` = unchanged, `null` clears; on epics/stories/bugs -> `400`. The Sprints tab's **Timeline** (and the MCP `get_sprint_timeline`) plans each owner's tasks in order: a task waits for the open tasks of every module its module depends on, each owner does one task at a time.
- Epics, stories and bugs only group other issues, so they can never be in a sprint (`sprintId` on them -> `400`); their tasks are planned instead. Issues carry `sprintId` (`number|null`, at most one sprint). `POST`/`PUT /api/issues` accept optional `sprintId`: omitted = unchanged (`null` on create), `null` = backlog, unknown id -> `404`, a closed sprint -> `400`
- `GET /api/graph` - `{modules, owners, relations, groups}` in one response
- There is no `PATCH`; updates use `PUT`. Deleting a module cascades to its relations.

### Module color, icon and API items

Modules also carry `color` (`"#rrggbb"` hex, stored lowercase, or `null` for the default accent colour), `icon` (emoji string, 1-8 characters after trim, or `null`) and `apiItems` (always present, in saved order). All three are returned by `GET /api/graph`, `/api/modules` and `/api/modules/:id`.

- `ApiItem` = `{id, kind, name, signature, description}`; `kind` is `function` | `endpoint` | `event` | `type` | `other`. Input items are `{id?, kind?, name, signature?, description?}`: `kind` defaults to `other`, `name` is required and non-empty, `signature`/`description` default to `""`. Limits: name 200, signature 1000, description 5000 characters.
- Style fields: `textColor` and `strokeColor` follow the same rules as `color` (`"#rrggbb"`, stored lowercase, or `null` = theme default text/border colour); `strokeStyle` is `"solid"` | `"dashed"` | `"dotted"`, never `null` in responses, default `"solid"`. All three are returned wherever a module is, and an invalid value (including `strokeStyle: null`) returns `400`.
- `POST`/`PUT` accept `color`, `textColor`, `strokeColor`, `strokeStyle`, `icon`, `apiItems` as optional. On `PUT`, an omitted field keeps its stored value (omitting `apiItems` does not wipe them); `null` clears `color`/`textColor`/`strokeColor`/`icon`.
- When present, `apiItems` replaces the whole list in one transaction with the module update: an item whose `id` belongs to this module is kept and updated, an item without `id` is inserted, stored items missing from the array are deleted, and an unknown or foreign `id` returns `400`. Order follows array position. There are no separate item endpoints.
- Invalid color/icon/kind, empty name, overlong field, non-array `apiItems` or a bad `id` return `400` `validation_error`.
- Deleting a module deletes its items. Existing databases are migrated at startup (idempotent).

```json
{
  "id": 1, "name": "Auth", "description": "", "ownerIds": [],
  "color": "#3366ff", "textColor": null, "strokeColor": "#112233", "strokeStyle": "dashed", "icon": "🔐",
  "apiItems": [
    {"id": 7, "kind": "endpoint", "name": "Login", "signature": "POST /login", "description": "Issues a token"}
  ]
}
```

Errors use the body `{"error": {"code": "...", "message": "..."}}`:

- `400` (`validation_error`) - invalid or missing fields, unknown owner/module ids, malformed JSON (other client errors such as `415` for a bad content-type keep their status and use the same body)
- `404` (`not_found`) - unknown resource or route
- `409` (`conflict`) - duplicate owner or group name (case-insensitive) or duplicate relation (same source and target)
- `500` (`internal_error`) - unexpected failure

## Make targets

Run `make` (or `make help`) to list targets: `install`, `dev-backend`, `dev-frontend`, `build`, `test`, `up`, `down`, `logs`, `restart`, `ps`, `clean`, and `nuke` (removes the data volume, asks for confirmation).

## MCP server

`mcp/` exposes pjPlanner to agents (Claude Code, Claude Desktop, Cursor) as MCP tools. It is a thin client over the REST API, so the backend must be running and reachable from the agent's machine (same LAN).

Users click **Connect agent** in the header. For Claude Code it shows one command that downloads `pjplanner-mcp.mjs` to `~/.pjplanner/` (a single self-contained file, Node 22+) and registers it. For other clients it shows the download link, where to save the file, and the JSON config. The server address shown is the host's LAN IP (`GET /api/mcp/info`); set `PUBLIC_URL` (e.g. `http://192.168.1.20:3030`) when running in Docker, since the container cannot see the host's LAN IP. Locally run `make build-mcp` first; the bundle is served from `MCP_BUNDLE` (default `../mcp/dist/pjplanner-mcp.mjs`, built into the Docker image).

- Set `PJPLANNER_PROJECT=<id>` in the MCP environment to work on a specific project (default: the oldest); `list_projects` shows the ids.
- Read tools (always): `list_projects`, `get_graph`, `get_module`, `find_dependencies` (transitive, upstream/downstream), `list_issues` (filter by state, module, owner, sprint, backlog), `get_issue`, `list_sprints`, `get_sprint` (issues grouped by module and by owner; omit the id for the active sprint), `get_sprint_timeline` (optimal order of work per owner given module dependencies and task estimates).
- Write tools (when `PJPLANNER_API_KEY` is set): `create_project`, `create_module`, `update_module`, `add_relation`, `remove_relation`, `create_issue`, `update_issue` (incl. `sprintId`, `estimate`), `create_sprint`, `update_sprint` (start/close), `auto_assign_sprint`.
- The key is `WRITE_KEY` from the server's `.env` (the old name `MCP_API_KEY` still works). Every write, from agents and from the web UI, must send it as `x-api-key` or gets `401 unauthorized`; reads stay open. The MCP sends it from `PJPLANNER_API_KEY`. In the web UI everyone is read-only until they click the lock in the header and enter the key (kept in that browser; `POST /api/unlock` checks it, `GET /api/access` says whether a key is required). `/api/mcp/info` no longer reveals the key, so the Connect-agent command shows a placeholder unless you have unlocked.
