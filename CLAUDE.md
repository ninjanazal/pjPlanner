# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

pjPlanner: a team planning tool. Modules (with owners, groups, API items, colors/icons, canvas positions) and directed relations between them, drawn as a graph; plus an issue tracker (epic/story/bug/task) and sprints. No auth, ever (open team platform). Multiple projects: everything is scoped by `project_id`, exportable/importable as JSON.

Three independent npm packages (no workspace root):
- `backend/` — Node 22+ (better-sqlite3@13 segfaults on Node 20), Fastify 5, better-sqlite3. Also serves the built frontend (`STATIC_DIR`) and the MCP bundle/skill.
- `frontend/` — Vite + React 18, `@xyflow/react` for the graph, `dagre` for auto layout.
- `mcp/` — stdio MCP server, a thin client over the REST API; bundled with esbuild to a single `dist/pjplanner-mcp.mjs` that the backend serves for download.

## Commands

```bash
make install            # npm install in backend + frontend
make dev-backend        # tsx watch, port 3030
make dev-frontend       # Vite dev server
make build              # tsc backend; tsc --noEmit + vite build frontend
make build-mcp          # build + bundle mcp (needed locally for /api/mcp/download)
make test               # backend + frontend vitest (mcp tests: cd mcp && npm test)
make up / down / redeploy / logs   # docker compose (redeploy = down + up --build) (data in pjplanner-data volume)
```

Single test: `cd backend && npx vitest run test/api.test.ts -t "name pattern"` (same pattern in `frontend/` and `mcp/`). Frontend type-check is part of `npm run build` (`tsc --noEmit`).

Backend env: `PORT`, `WRITE_KEY` (both from `.env`), `DB_PATH`, `STATIC_DIR`, `PUBLIC_URL` (LAN URL shown in "Connect agent", needed in Docker), `MCP_BUNDLE`, `MCP_SKILL`.

## Architecture

**Backend** is essentially one file: `backend/src/app.ts` exports `buildApp(dbPath)` which opens SQLite, runs idempotent startup migrations (`openDb`, `migrate*` functions — schema changes must be additive/migrating since existing DBs exist), and registers all routes. `index.ts` only listens. Tests call `buildApp(':memory:')` and use `app.inject`. Validation helpers (`bad`, `notFound`, `colorField`, `iconField`, `id`) throw `HttpError`; all errors serialize as `{"error": {"code", "message"}}` with codes `validation_error` (400), `not_found` (404), `conflict` (409), `internal_error` (500).

Key semantics (full contract in README "API" section — keep README in sync when changing the API):
- `PUT` on modules/owners/groups: omitted field = unchanged, `null` = clear. `PUT /api/issues/:id` is a **full** update.
- Module `apiItems` are replaced wholesale in one transaction (no item endpoints).
- Groups nest via `parentId` (max depth 4, no cycles); deleting a group moves children up and ungroups modules.
- Issue types are `epic`, `story`, `bug`, `task` (old subtask rows migrate to task). Epic holds stories/bugs/tasks, story and bug hold tasks; only tasks may carry module, assignee (must own that module) and sprint. `rollupModuleIds` = own module + descendants'.
- Sprints: planned → active → closed, only one active; activating auto-assigns owners to unassigned tasks, closing sends open tasks back to the backlog.
- Projects: a fresh DB has none (users create them; data routes 404 with code `no_project` until then; pre-projects data migrates into "My project"). The active project of a request comes from the `x-project` header (`?project=`), held in `AsyncLocalStorage` (`P()` in `app.ts`); any new query on modules/owners/groups/issues/sprints must filter by `project_id = P()` (relations/API items inherit it via their module). Frontend `api.ts` sends the header from localStorage; MCP uses `PJPLANNER_PROJECT`. Export/import: `GET /api/projects/:id/export`, `POST /api/projects/import` (always a new project, ids remapped).
- Write key: config comes from `.env` at the repo root (`.env.example`; `PORT`, `WRITE_KEY`, `PUBLIC_URL`), loaded by `backend/src/index.ts`, compose and the Vite proxy. When `WRITE_KEY` is set every non-GET `/api` request, UI and agents alike, needs `x-api-key` (else 401); unset = open (tests rely on this; `index.ts` refuses to start without it). The UI is read-only until unlocked via the header lock (`LockButton`, key in localStorage).

**Frontend**: `App.tsx` holds the loaded graph/issues/sprints state and hash routing (`route.ts`: diagram, owners, groups, issues, sprints). `api.ts` is the fetch wrapper; `types.ts` mirrors backend payloads. Graph rendering in `components/GraphView.tsx` with custom edge routing (`edgeRouting.ts`, `RoutedEdge.tsx` — floating arrows attached at nearest card border, reverse pairs curved apart), group boxes derived from member cards (`groupBoxes.ts`), snap guides, dagre layout (`layout.ts`). Editing happens in modal popups (`Modal.tsx`); dirty modals block navigation. Saved colours live in localStorage, not the DB. Tests in `src/__tests__/` (vitest + jsdom + Testing Library).

**MCP**: `mcp/src/tools.ts` defines tools (read tools always; write tools only when `PJPLANNER_API_KEY` is set), `api.ts` calls the backend, `deps.ts`/`sprint.ts` compute transitive dependencies and sprint groupings. `mcp/skill/SKILL.md` is served to users as an agent skill for mapping a codebase into pjPlanner.

## Product decisions

`.maestro/memory/decisions.md` records product decisions with rationale (e.g. no login, issue states only open/closed, one group per module, one module per issue, ungroup only explicitly). Check it before changing UX behaviour.
