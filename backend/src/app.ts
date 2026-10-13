import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const bad = (m: string) => new HttpError(400, 'validation_error', m);
const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);

// The write key (env WRITE_KEY, from .env; MCP_API_KEY is the old name). Anyone writing, the web UI included, must send it as
// `x-api-key`. Unset means writes are open, which only tests and ad-hoc embedding rely on: index.ts refuses to start without it.
const writeKey = () => process.env.WRITE_KEY || process.env.MCP_API_KEY || '';
const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// First non-loopback IPv4 address of this machine (what other hosts on the LAN can reach).
export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

const KINDS = ['function', 'endpoint', 'event', 'type', 'other'];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Old schema had owners.email NOT NULL UNIQUE, which DROP COLUMN cannot remove, so rebuild the table.
function migrateOwners(db: Database.Database) {
  const names = () => (db.prepare('PRAGMA table_info(owners)').all() as { name: string }[]).map((c) => c.name);
  if (names().includes('email')) {
    // foreign_keys cannot be changed inside a transaction; with it ON, DROP TABLE would cascade-delete module_owners.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS owners_new;
          CREATE TABLE owners_new (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT);
          INSERT INTO owners_new (id, name) SELECT id, name FROM owners;
          DROP TABLE owners;
          ALTER TABLE owners_new RENAME TO owners;
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after owners migration');
  }
  const have = names();
  for (const c of ['color', 'icon']) {
    if (!have.includes(c)) db.exec(`ALTER TABLE owners ADD COLUMN ${c} TEXT`);
  }
}

// SQLite cannot alter a CHECK constraint, so old todo/doing/done issues are rebuilt as open/closed.
function migrateIssueStates(db: Database.Database) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'").get() as { sql: string } | undefined;
  if (!row || !row.sql.includes('todo')) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS issues_new;
        CREATE TABLE issues_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK (type IN ('epic','story','task','bug','subtask')),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
          owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
          module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO issues_new (id, type, title, description, parent_id, owner_id, module_id, state, created_at)
          SELECT id, type, title, description, parent_id, owner_id, module_id,
            CASE WHEN state = 'done' THEN 'closed' ELSE 'open' END,
            COALESCE(created_at, CURRENT_TIMESTAMP) FROM issues;
        DROP TABLE issues;
        ALTER TABLE issues_new RENAME TO issues;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('foreign key check failed after issues migration');
}

// Subtask was removed: it becomes a task. A task left under a task, or a bug/story under a non-epic, moves up to the nearest valid parent.
function migrateIssueTypes(db: Database.Database) {
  db.transaction(() => {
    db.exec("UPDATE issues SET type = 'task' WHERE type = 'subtask'");
    const bad = db.prepare(`SELECT c.id, p.parent_id AS up FROM issues c JOIN issues p ON p.id = c.parent_id
      WHERE (c.type = 'task' AND p.type = 'task') OR (c.type IN ('bug', 'story') AND p.type <> 'epic')`);
    const move = db.prepare('UPDATE issues SET parent_id = ? WHERE id = ?');
    for (let rows = bad.all() as { id: number; up: number | null }[]; rows.length; rows = bad.all() as { id: number; up: number | null }[]) {
      rows.forEach((r) => move.run(r.up, r.id));
    }
  })();
}

// Everything belongs to a project. A fresh database has none (users create their own); data from before projects
// existed is moved into one project named "My project".
// Added last because the rebuild migrations above recreate tables without project_id.
function migrateProjects(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const tables = ['modules', 'owners', 'groups', 'issues', 'sprints'];
  for (const t of tables) {
    if (!(db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((c) => c.name === 'project_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE`);
    }
  }
  if (!tables.some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE project_id IS NULL`).get())) return;
  const existing = db.prepare('SELECT MIN(id) AS id FROM projects').get() as { id: number | null };
  const pid = existing.id ?? Number(db.prepare("INSERT INTO projects (name) VALUES ('My project')").run().lastInsertRowid);
  for (const t of tables) db.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id IS NULL`).run(pid);
}

function openDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT
    );
    CREATE TABLE IF NOT EXISTS module_owners (
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      PRIMARY KEY (module_id, owner_id)
    );
    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      label TEXT,
      UNIQUE (source_id, target_id),
      CHECK (source_id <> target_id)
    );
  `);
  migrateOwners(db);
  const relCols = db.prepare('PRAGMA table_info(relations)').all() as { name: string }[];
  if (!relCols.some((x) => x.name === 'color')) db.exec('ALTER TABLE relations ADD COLUMN color TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT)');
  const groupCols = db.prepare('PRAGMA table_info(groups)').all() as { name: string }[];
  if (!groupCols.some((x) => x.name === 'parent_id')) {
    db.exec('ALTER TABLE groups ADD COLUMN parent_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL');
  }
  const cols = db.prepare('PRAGMA table_info(modules)').all() as { name: string }[];
  if (!cols.some((x) => x.name === 'group_id')) {
    db.exec('ALTER TABLE modules ADD COLUMN group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL');
  }
  for (const c of ['color', 'icon']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} TEXT NULL`);
  }
  for (const c of ['x', 'y']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} REAL NULL`);
  }
  for (const c of ['text_color', 'stroke_color']) {
    if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE modules ADD COLUMN ${c} TEXT`);
  }
  if (!cols.some((x) => x.name === 'stroke_style')) {
    db.exec(`ALTER TABLE modules ADD COLUMN stroke_style TEXT NOT NULL DEFAULT 'solid'`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS module_api_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('function','endpoint','event','type','other')),
      name TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('epic','story','task','bug','subtask')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
      owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
      module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'module_id')) {
    db.exec('ALTER TABLE issues ADD COLUMN module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL');
  }
  migrateIssueStates(db);
  migrateIssueTypes(db);
  db.exec("UPDATE issues SET owner_id = NULL, module_id = NULL WHERE type <> 'task'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','active','closed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Sprints no longer have dates (opened and closed by hand); drop them from databases created earlier.
  for (const c of ['start_date', 'end_date']) {
    if ((db.prepare('PRAGMA table_info(sprints)').all() as { name: string }[]).some((x) => x.name === c)) db.exec(`ALTER TABLE sprints DROP COLUMN ${c}`);
  }
  // Added after migrateIssueStates, which rebuilds the table without it.
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'sprint_id')) {
    db.exec('ALTER TABLE issues ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL');
  }
  // Effort of a task in whole steps (null = 1); the sprint timeline plans with it.
  if (!(db.prepare('PRAGMA table_info(issues)').all() as { name: string }[]).some((c) => c.name === 'estimate')) {
    db.exec('ALTER TABLE issues ADD COLUMN estimate INTEGER');
  }
  db.exec("UPDATE issues SET sprint_id = NULL WHERE type <> 'task' AND sprint_id IS NOT NULL"); // epics and bugs are never in a sprint
  migrateProjects(db);
  return db;
}

type ApiItemInput = { id?: number; kind: string; name: string; signature: string; description: string };
type Body = Record<string, unknown>;
const obj = (b: unknown): Body => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
  return b as Body;
};
const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} must be a non-empty string`);
  return v.trim();
};
const colorField = (b: Body, field: string): string | null | undefined => {
  const v = b[field];
  if (v === undefined || v === null) return v;
  if (typeof v === 'string' && COLOR_RE.test(v)) return v.toLowerCase();
  throw bad(`${field} must be a #rrggbb hex string or null`);
};
const iconField = (b: Body): string | null | undefined => {
  if (b.icon === undefined || b.icon === null) return b.icon;
  if (typeof b.icon !== 'string') throw bad('icon must be a string or null');
  const t = b.icon.trim();
  const len = [...t].length;
  if (len < 1 || len > 8) throw bad('icon must be 1-8 characters');
  return t;
};
const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw notFound('resource');
  return n;
};

const projectStore = new AsyncLocalStorage<number>();

export function buildApp(dbPath: string = process.env.DB_PATH ?? './data/pjplanner.db'): FastifyInstance {
  const db = openDb(dbPath);
  const app = Fastify();
  app.addHook('onClose', async () => { db.close(); });

  // Agents identify themselves with `x-agent: mcp` and must present the key for any write. A wrong key is
  // rejected on any request. The web UI sends neither header and is unaffected.
  app.addHook('onRequest', async (req, reply) => {
    const key = writeKey();
    if (!key || !req.url.startsWith('/api/')) return;
    const sent = req.headers['x-api-key'];
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if ((sent !== undefined || write) && !(typeof sent === 'string' && sameKey(sent, key))) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid API key' } });
    }
  });

  // The active project of the request: `x-project` header or `?project=`, else the oldest project. Kept in
  // AsyncLocalStorage so every query helper can scope itself without passing it around.
  const P = (): number => projectStore.getStore() as number;
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/projects') || path.startsWith('/api/mcp') || path === '/api/health' || path === '/api/access' || path === '/api/unlock') return done();
    try {
      const want = req.headers['x-project'] ?? (req.query as any)?.project;
      const row = (want === undefined
        ? db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get()
        : db.prepare('SELECT id FROM projects WHERE id = ?').get(Number(want))) as { id: number } | undefined;
      if (!row) {
        if (want === undefined) throw new HttpError(404, 'no_project', 'No project yet; create one first');
        throw notFound('Project');
      }
      projectStore.run(row.id, done);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 500;
      reply.status(status).send({ error: { code: e instanceof HttpError ? e.code : 'internal_error', message: e.message } });
    }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err.statusCode && err.statusCode < 500) {
      const code = err.statusCode === 404 ? 'not_found' : 'validation_error';
      return reply.status(err.statusCode).send({ error: { code, message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && staticIndex) {
      return reply.type('text/html').send(fs.readFileSync(staticIndex));
    }
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const ownerRow = (r: any) => ({ id: r.id, name: r.name, color: r.color ?? null, icon: r.icon ?? null });
  const groupRow = (r: any) => ({ ...ownerRow(r), parentId: r.parent_id ?? null });
  const relRow = (r: any) => ({ id: r.id, sourceId: r.source_id, targetId: r.target_id, label: r.label, color: r.color ?? null });
  const modules = (where = '', ...args: unknown[]) => {
    const rows = db.prepare(`SELECT * FROM modules WHERE project_id = ? ${where} ORDER BY id`).all(P(), ...args) as any[];
    const owners = db.prepare('SELECT mo.module_id, mo.owner_id FROM module_owners mo JOIN modules m ON m.id = mo.module_id WHERE m.project_id = ? ORDER BY mo.owner_id').all(P()) as any[];
    const items = db.prepare('SELECT i.* FROM module_api_items i JOIN modules m ON m.id = i.module_id WHERE m.project_id = ? ORDER BY i.position, i.id').all(P()) as any[];
    const ownersBy = new Map<number, number[]>(), itemsBy = new Map<number, any[]>();
    for (const o of owners) ownersBy.set(o.module_id, [...(ownersBy.get(o.module_id) ?? []), o.owner_id]);
    for (const i of items) itemsBy.set(i.module_id, [...(itemsBy.get(i.module_id) ?? []), i]);
    return rows.map((m) => ({
      id: m.id, name: m.name, description: m.description,
      color: m.color ?? null, icon: m.icon ?? null,
      textColor: m.text_color ?? null, strokeColor: m.stroke_color ?? null,
      strokeStyle: m.stroke_style ?? 'solid',
      x: m.x ?? null, y: m.y ?? null,
      groupId: m.group_id ?? null,
      apiItems: (itemsBy.get(m.id) ?? []).map((i) => ({
        id: i.id, kind: i.kind, name: i.name, signature: i.signature, description: i.description,
      })),
      ownerIds: ownersBy.get(m.id) ?? [],
    }));
  };
  const getModule = (mid: number) => {
    const m = modules('AND id = ?', mid)[0];
    if (!m) throw notFound('Module');
    return m;
  };
  const getOwner = (oid: number) => {
    const o = db.prepare('SELECT * FROM owners WHERE id = ? AND project_id = ?').get(oid, P());
    if (!o) throw notFound('Owner');
    return ownerRow(o);
  };
  const getGroup = (gid: number) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ? AND project_id = ?').get(gid, P());
    if (!g) throw notFound('Group');
    return groupRow(g);
  };
  const MAX_GROUP_DEPTH = 4;
  // Validates a new parent for `gid` (0 for a group not yet created): known, no cycle, resulting depth <= MAX_GROUP_DEPTH.
  const checkParent = (parentId: unknown, gid: number): number | null => {
    if (parentId === null) return null;
    if (!Number.isInteger(parentId) || !db.prepare('SELECT 1 FROM groups WHERE id = ? AND project_id = ?').get(parentId, P())) {
      throw bad('parentId refers to an unknown group');
    }
    const pid = parentId as number;
    if (pid === gid) throw bad('a group cannot be its own parent');
    const parentOf = db.prepare('SELECT parent_id FROM groups WHERE id = ?');
    let depth = 0;
    for (let cur: number | null = pid; cur !== null; depth++) {
      if (cur === gid) throw bad('parentId would create a cycle');
      cur = ((parentOf.get(cur) as any)?.parent_id ?? null) as number | null;
    }
    let height = 0;
    const kids = db.prepare('SELECT id FROM groups WHERE parent_id = ?');
    const walk = (n: number, d: number) => {
      height = Math.max(height, d);
      for (const k of kids.all(n) as { id: number }[]) walk(k.id, d + 1);
    };
    if (gid) walk(gid, 1); else height = 1;
    if (depth + height > MAX_GROUP_DEPTH) throw bad(`groups can be nested at most ${MAX_GROUP_DEPTH} levels deep`);
    return pid;
  };
  const getRel = (rid: number) => {
    const r = db.prepare('SELECT r.* FROM relations r JOIN modules m ON m.id = r.source_id WHERE r.id = ? AND m.project_id = ?').get(rid, P());
    if (!r) throw notFound('Relation');
    return relRow(r);
  };
  const moduleExists = (mid: unknown, field: string) => {
    if (!Number.isInteger(mid) || !db.prepare('SELECT 1 FROM modules WHERE id = ? AND project_id = ?').get(mid, P())) {
      throw bad(`${field} refers to an unknown module`);
    }
  };

  function parseModule(b: Body) {
    const name = str(b.name, 'name');
    const description = b.description === undefined ? '' : b.description;
    if (typeof description !== 'string') throw bad('description must be a string');
    const ownerIds = b.ownerIds === undefined ? [] : b.ownerIds;
    if (!Array.isArray(ownerIds) || !ownerIds.every((x) => Number.isInteger(x))) throw bad('ownerIds must be an array of integers');
    const unique = [...new Set(ownerIds as number[])];
    for (const o of unique) {
      if (!db.prepare('SELECT 1 FROM owners WHERE id = ? AND project_id = ?').get(o, P())) throw bad(`unknown owner id ${o}`);
    }
    return { name, description, ownerIds: unique, ...parseExtras(b) };
  }

  // Absent fields stay undefined so PUT can leave stored values untouched.
  function parseExtras(b: Body) {
    const color = colorField(b, 'color');
    const textColor = colorField(b, 'textColor');
    const strokeColor = colorField(b, 'strokeColor');
    let strokeStyle: string | undefined;
    if (b.strokeStyle !== undefined) {
      if (typeof b.strokeStyle !== 'string' || !STROKE_STYLES.includes(b.strokeStyle)) {
        throw bad(`strokeStyle must be one of ${STROKE_STYLES.join(', ')}`);
      }
      strokeStyle = b.strokeStyle;
    }
    const icon = iconField(b);
    let apiItems: ApiItemInput[] | undefined;
    if (b.apiItems !== undefined) {
      if (!Array.isArray(b.apiItems)) throw bad('apiItems must be an array');
      const seen = new Set<number>();
      apiItems = b.apiItems.map((raw: unknown, i: number) => {
        const it = obj(raw);
        const f = `apiItems[${i}]`;
        let itemId: number | undefined;
        if (it.id !== undefined) {
          if (!Number.isInteger(it.id) || (it.id as number) < 1 || seen.has(it.id as number)) throw bad(`${f}.id is invalid`);
          itemId = it.id as number;
          seen.add(itemId);
        }
        const kind = it.kind === undefined ? 'other' : it.kind;
        if (typeof kind !== 'string' || !KINDS.includes(kind)) throw bad(`${f}.kind must be one of ${KINDS.join(', ')}`);
        const name = str(it.name, `${f}.name`);
        const opt = (v: unknown, field: string, max: number) => {
          if (v === undefined) return '';
          if (typeof v !== 'string') throw bad(`${f}.${field} must be a string`);
          if (v.length > max) throw bad(`${f}.${field} must be at most ${max} characters`);
          return v;
        };
        if (name.length > 200) throw bad(`${f}.name must be at most 200 characters`);
        return { id: itemId, kind, name, signature: opt(it.signature, 'signature', 1000), description: opt(it.description, 'description', 5000) };
      });
    }
    let groupId: number | null | undefined = b.groupId as undefined | null;
    if (groupId !== undefined && groupId !== null) {
      if (!Number.isInteger(groupId) || !db.prepare('SELECT 1 FROM groups WHERE id = ? AND project_id = ?').get(groupId, P())) {
        throw bad('groupId refers to an unknown group');
      }
    }
    return { color, icon, textColor, strokeColor, strokeStyle, apiItems, groupId };
  }
  const setItems = (mid: number, items: ApiItemInput[]) => {
    const existing = new Set((db.prepare('SELECT id FROM module_api_items WHERE module_id = ?').all(mid) as any[]).map((r) => r.id as number));
    for (const it of items) if (it.id !== undefined && !existing.has(it.id)) throw bad(`apiItems id ${it.id} does not belong to this module`);
    const keep = new Set(items.filter((i) => i.id !== undefined).map((i) => i.id));
    for (const e of existing) if (!keep.has(e)) db.prepare('DELETE FROM module_api_items WHERE id = ?').run(e);
    const upd = db.prepare('UPDATE module_api_items SET kind = ?, name = ?, signature = ?, description = ?, position = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO module_api_items (module_id, kind, name, signature, description, position) VALUES (?, ?, ?, ?, ?, ?)');
    items.forEach((it, pos) => {
      if (it.id !== undefined) upd.run(it.kind, it.name, it.signature, it.description, pos, it.id);
      else ins.run(mid, it.kind, it.name, it.signature, it.description, pos);
    });
  };
  const setOwners = (mid: number, ownerIds: number[]) => {
    db.prepare('DELETE FROM module_owners WHERE module_id = ?').run(mid);
    const ins = db.prepare('INSERT INTO module_owners (module_id, owner_id) VALUES (?, ?)');
    for (const o of ownerIds) ins.run(mid, o);
  };

  function parseOwner(b: Body) {
    const name = str(b.name, 'name');
    if (name.length > 200) throw bad('name must be at most 200 characters');
    return { name, color: colorField(b, 'color'), icon: iconField(b) };
  }
  // Uniqueness is enforced here only: existing data may already contain duplicate names.
  const checkNameFree = (name: string, exceptId = 0, table: 'owners' | 'groups' = 'owners') => {
    const lower = name.toLowerCase();
    const rows = db.prepare(`SELECT name FROM ${table} WHERE id <> ? AND project_id = ?`).all(exceptId, P()) as { name: string }[];
    if (rows.some((r) => r.name.toLowerCase() === lower)) {
      throw new HttpError(409, 'conflict', `A ${table === 'owners' ? 'owner' : 'group'} with this name already exists`);
    }
  };

  const labelOf = (v: unknown) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw bad('label must be a string or null');
    return v;
  };

  app.get('/api/health', async () => ({ status: 'ok' }));

  // Address agents should use to reach this server: PUBLIC_URL if set (needed behind Docker/proxies), else LAN IP.
  app.get('/api/mcp/info', async () => {
    const ip = lanAddress();
    const url = process.env.PUBLIC_URL || `http://${ip ?? 'localhost'}:${process.env.PORT ?? 3030}`;
    return { url: url.replace(/\/$/, '') };
  });

  // Lets the web UI check a key before it stores it: the onRequest hook above has already rejected a wrong one.
  app.post('/api/unlock', async () => ({ ok: true, locked: Boolean(writeKey()) }));
  // Whether writes need a key at all, so the UI can skip the lock when running open.
  app.get('/api/access', async () => ({ locked: Boolean(writeKey()) }));

  // Self-contained MCP bundle (built from ../mcp) so users can download it from the UI.
  app.get('/api/mcp/download', async (_req, reply) => {
    const file = path.resolve(process.env.MCP_BUNDLE ?? '../mcp/dist/pjplanner-mcp.mjs');
    if (!fs.existsSync(file)) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'MCP bundle not built' } });
    }
    return reply
      .type('text/javascript')
      .header('content-disposition', 'attachment; filename="pjplanner-mcp.mjs"')
      .send(fs.readFileSync(file));
  });

  // Claude Code skill that maps a codebase into the diagram through the MCP tools.
  app.get('/api/mcp/skill', async (_req, reply) => {
    const file = path.resolve(process.env.MCP_SKILL ?? '../mcp/skill/SKILL.md');
    if (!fs.existsSync(file)) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Skill file not found' } });
    }
    return reply.type('text/markdown').send(fs.readFileSync(file));
  });

  const ownerList = () => (db.prepare('SELECT * FROM owners WHERE project_id = ? ORDER BY id').all(P()) as any[]).map(ownerRow);
  const groupList = () => (db.prepare('SELECT * FROM groups WHERE project_id = ? ORDER BY id').all(P()) as any[]).map(groupRow);
  const relList = () => (db.prepare('SELECT r.* FROM relations r JOIN modules m ON m.id = r.source_id WHERE m.project_id = ? ORDER BY r.id').all(P()) as any[]).map(relRow);

  app.get('/api/graph', async () => ({
    modules: modules(),
    owners: ownerList(),
    relations: relList(),
    groups: groupList(),
  }));

  app.get('/api/modules', async () => modules());
  app.post('/api/modules', async (req, reply) => {
    const m = parseModule(obj(req.body));
    const mid = db.transaction(() => {
      const r = db.prepare('INSERT INTO modules (project_id, name, description, color, icon, text_color, stroke_color, stroke_style, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(P(), m.name, m.description, m.color ?? null, m.icon ?? null, m.textColor ?? null, m.strokeColor ?? null, m.strokeStyle ?? 'solid', m.groupId ?? null);
      setOwners(Number(r.lastInsertRowid), m.ownerIds);
      if (m.apiItems) setItems(Number(r.lastInsertRowid), m.apiItems);
      return Number(r.lastInsertRowid);
    })();
    return reply.status(201).send(getModule(mid));
  });
  app.get('/api/modules/:id', async (req) => getModule(id((req.params as any).id)));
  app.put('/api/modules/:id', async (req) => {
    const mid = id((req.params as any).id);
    getModule(mid);
    const m = parseModule(obj(req.body));
    db.transaction(() => {
      db.prepare('UPDATE modules SET name = ?, description = ? WHERE id = ?').run(m.name, m.description, mid);
      if (m.color !== undefined) db.prepare('UPDATE modules SET color = ? WHERE id = ?').run(m.color, mid);
      if (m.icon !== undefined) db.prepare('UPDATE modules SET icon = ? WHERE id = ?').run(m.icon, mid);
      if (m.textColor !== undefined) db.prepare('UPDATE modules SET text_color = ? WHERE id = ?').run(m.textColor, mid);
      if (m.strokeColor !== undefined) db.prepare('UPDATE modules SET stroke_color = ? WHERE id = ?').run(m.strokeColor, mid);
      if (m.strokeStyle !== undefined) db.prepare('UPDATE modules SET stroke_style = ? WHERE id = ?').run(m.strokeStyle, mid);
      if (m.groupId !== undefined) db.prepare('UPDATE modules SET group_id = ? WHERE id = ?').run(m.groupId, mid);
      setOwners(mid, m.ownerIds);
      if (m.apiItems) setItems(mid, m.apiItems);
    })();
    return getModule(mid);
  });
  app.put('/api/modules/:id/position', async (req) => {
    const mid = id((req.params as any).id);
    getModule(mid);
    const b = obj(req.body);
    for (const k of ['x', 'y']) {
      const v = b[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) throw bad(`${k} must be a finite number with abs <= 1e6`);
    }
    db.prepare('UPDATE modules SET x = ?, y = ? WHERE id = ?').run(b.x, b.y, mid);
    return getModule(mid);
  });
  app.put('/api/modules/positions', async (req) => {
    const list = obj(req.body).positions;
    if (!Array.isArray(list) || list.length < 1 || list.length > 500) throw bad('positions must be an array of 1-500 entries');
    const seen = new Set<number>();
    const entries = list.map((raw: unknown, i: number) => {
      const e = obj(raw);
      if (!Number.isInteger(e.id)) throw bad(`positions[${i}].id must be an integer`);
      const mid = e.id as number;
      if (seen.has(mid)) throw bad(`positions[${i}].id is duplicated`);
      seen.add(mid);
      for (const k of ['x', 'y']) {
        const v = e[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) throw bad(`positions[${i}].${k} must be a finite number with abs <= 1e6`);
      }
      moduleExists(mid, `positions[${i}].id`);
      return { id: mid, x: e.x as number, y: e.y as number };
    });
    const upd = db.prepare('UPDATE modules SET x = ?, y = ? WHERE id = ?');
    db.transaction(() => { for (const e of entries) upd.run(e.x, e.y, e.id); })();
    return modules().filter((m) => seen.has(m.id));
  });
  app.delete('/api/modules/:id', async (req, reply) => {
    const mid = id((req.params as any).id);
    getModule(mid);
    db.prepare('DELETE FROM modules WHERE id = ?').run(mid);
    return reply.status(204).send();
  });

  app.get('/api/owners', async () => ownerList());
  app.post('/api/owners', async (req, reply) => {
    const o = parseOwner(obj(req.body));
    checkNameFree(o.name);
    const r = db.prepare('INSERT INTO owners (project_id, name, color, icon) VALUES (?, ?, ?, ?)').run(P(), o.name, o.color ?? null, o.icon ?? null);
    return reply.status(201).send(getOwner(Number(r.lastInsertRowid)));
  });
  app.put('/api/owners/:id', async (req) => {
    const oid = id((req.params as any).id);
    getOwner(oid);
    const o = parseOwner(obj(req.body));
    checkNameFree(o.name, oid);
    db.transaction(() => {
      db.prepare('UPDATE owners SET name = ? WHERE id = ?').run(o.name, oid);
      if (o.color !== undefined) db.prepare('UPDATE owners SET color = ? WHERE id = ?').run(o.color, oid);
      if (o.icon !== undefined) db.prepare('UPDATE owners SET icon = ? WHERE id = ?').run(o.icon, oid);
    })();
    return getOwner(oid);
  });
  app.delete('/api/owners/:id', async (req, reply) => {
    const oid = id((req.params as any).id);
    getOwner(oid);
    db.prepare('DELETE FROM owners WHERE id = ?').run(oid);
    return reply.status(204).send();
  });

  app.get('/api/groups', async () => groupList());
  app.post('/api/groups', async (req, reply) => {
    const body = obj(req.body);
    const g = parseOwner(body);
    checkNameFree(g.name, 0, 'groups');
    const parentId = body.parentId === undefined ? null : checkParent(body.parentId, 0);
    const r = db.prepare('INSERT INTO groups (project_id, name, color, icon, parent_id) VALUES (?, ?, ?, ?, ?)').run(P(), g.name, g.color ?? null, g.icon ?? null, parentId);
    return reply.status(201).send(getGroup(Number(r.lastInsertRowid)));
  });
  app.put('/api/groups/:id', async (req) => {
    const gid = id((req.params as any).id);
    getGroup(gid);
    const body = obj(req.body);
    const g = parseOwner(body);
    checkNameFree(g.name, gid, 'groups');
    const parentId = body.parentId === undefined ? undefined : checkParent(body.parentId, gid);
    db.transaction(() => {
      db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(g.name, gid);
      if (g.color !== undefined) db.prepare('UPDATE groups SET color = ? WHERE id = ?').run(g.color, gid);
      if (g.icon !== undefined) db.prepare('UPDATE groups SET icon = ? WHERE id = ?').run(g.icon, gid);
      if (parentId !== undefined) db.prepare('UPDATE groups SET parent_id = ? WHERE id = ?').run(parentId, gid);
    })();
    return getGroup(gid);
  });
  app.delete('/api/groups/:id', async (req, reply) => {
    const gid = id((req.params as any).id);
    const deleted = db.prepare('SELECT parent_id FROM groups WHERE id = ? AND project_id = ?').get(gid, P()) as { parent_id: number | null } | undefined;
    if (!deleted) throw notFound('Group');
    db.transaction(() => {
      db.prepare('UPDATE groups SET parent_id = ? WHERE parent_id = ?').run(deleted.parent_id, gid);
      db.prepare('UPDATE modules SET group_id = NULL WHERE group_id = ?').run(gid);
      db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
    })();
    return reply.status(204).send();
  });

  app.get('/api/relations', async () => relList());
  app.post('/api/relations', async (req, reply) => {
    const b = obj(req.body);
    moduleExists(b.sourceId, 'sourceId');
    moduleExists(b.targetId, 'targetId');
    if (b.sourceId === b.targetId) throw bad('a module cannot relate to itself');
    const label = labelOf(b.label);
    const color = colorField(b, 'color') ?? null;
    if (db.prepare('SELECT 1 FROM relations WHERE source_id = ? AND target_id = ?').get(b.sourceId, b.targetId)) {
      throw new HttpError(409, 'conflict', 'This relation already exists');
    }
    const r = db.prepare('INSERT INTO relations (source_id, target_id, label, color) VALUES (?, ?, ?, ?)').run(b.sourceId, b.targetId, label, color);
    return reply.status(201).send(getRel(Number(r.lastInsertRowid)));
  });
  app.put('/api/relations/:id', async (req) => {
    const rid = id((req.params as any).id);
    getRel(rid);
    const b = obj(req.body);
    if (b.label === undefined && b.color === undefined) throw bad('label or color is required');
    const color = colorField(b, 'color');
    const label = b.label === undefined ? undefined : labelOf(b.label);
    db.transaction(() => {
      if (label !== undefined) db.prepare('UPDATE relations SET label = ? WHERE id = ?').run(label, rid);
      if (color !== undefined) db.prepare('UPDATE relations SET color = ? WHERE id = ?').run(color, rid);
    })();
    return getRel(rid);
  });
  app.delete('/api/relations/:id', async (req, reply) => {
    const rid = id((req.params as any).id);
    getRel(rid);
    db.prepare('DELETE FROM relations WHERE id = ?').run(rid);
    return reply.status(204).send();
  });

  const ISSUE_TYPES = ['epic', 'story', 'bug', 'task'];
  // Epics, stories and bugs hold children: an epic holds stories, bugs and tasks; a story or a bug holds tasks.
  const PARENTS: Record<string, string[]> = { epic: [], story: ['epic'], bug: ['epic'], task: ['epic', 'story', 'bug'] };
  const ISSUE_STATES = ['open', 'closed'];
  const issueRows = () => db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id').all(P()) as any[];
  const issuePayloads = (given?: any[]) => {
    const all = issueRows();
    const rows = given ?? all;
    const kids = new Map<number, number[]>();
    for (const r of all) if (r.parent_id != null) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r.id]);
    const byId = new Map(all.map((r) => [r.id as number, r]));
    const rollup = (i: number): Set<number> => {
      const out = new Set<number>();
      const r = byId.get(i);
      if (r?.module_id != null) out.add(r.module_id);
      for (const c of kids.get(i) ?? []) for (const m of rollup(c)) out.add(m);
      return out;
    };
    return rows.map((r) => ({
      id: r.id, type: r.type, title: r.title, description: r.description,
      parentId: r.parent_id ?? null, ownerId: r.owner_id ?? null, moduleId: r.module_id ?? null, sprintId: r.sprint_id ?? null, estimate: r.estimate ?? null, state: r.state,
      childIds: kids.get(r.id) ?? [],
      rollupModuleIds: [...rollup(r.id)].sort((a, b) => a - b),
    }));
  };
  const getIssue = (iid: number) => {
    const r = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P());
    if (!r) throw notFound('Issue');
    return issuePayloads([r])[0];
  };
  const optId = (v: unknown, field: string): number | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad(`${field} must be a positive integer or null`);
    return v;
  };
  // existing = the issue being updated (null on create)
  const parseIssue = (b: Body, existing: any | null) => {
    const title = str(b.title, 'title');
    if (typeof b.type !== 'string' || !ISSUE_TYPES.includes(b.type)) throw bad(`type must be one of ${ISSUE_TYPES.join(', ')}`);
    const state = b.state === undefined ? 'open' : b.state;
    if (typeof state !== 'string' || !ISSUE_STATES.includes(state)) throw bad(`state must be one of ${ISSUE_STATES.join(', ')}`);
    if (b.description !== undefined && typeof b.description !== 'string') throw bad('description must be a string');
    const type = b.type;
    const parentId = optId(b.parentId, 'parentId');
    const ownerId = optId(b.ownerId, 'ownerId');
    const moduleId = optId(b.moduleId, 'moduleId');
    // Epics and bugs only group work; the module and the assignee live on the tasks.
    if (b.type !== 'task' && (ownerId != null || moduleId != null)) throw bad(`a${b.type === 'epic' ? 'n' : ''} ${b.type} cannot have an assignee or a module; set them on its tasks`);
    // sprintId: omitted keeps the current sprint (the UI/agents often send a full body), null moves to the backlog.
    const sprintId = b.type !== 'task' ? null : b.sprintId === undefined ? (existing?.sprint_id ?? null) : optId(b.sprintId, 'sprintId');
    // Epics and bugs only group tasks, so they are never planned into a sprint (their tasks are).
    if (b.type !== 'task' && b.sprintId != null) throw bad(`a${b.type === 'epic' ? 'n' : ''} ${b.type} cannot be in a sprint; add its tasks instead`);
    if (sprintId != null && sprintId !== (existing?.sprint_id ?? null)) {
      const sp = db.prepare('SELECT state FROM sprints WHERE id = ? AND project_id = ?').get(sprintId, P()) as { state: string } | undefined;
      if (!sp) throw notFound('Sprint');
      if (sp.state === 'closed') throw bad('cannot add an issue to a closed sprint');
    }
    // estimate: omitted keeps the current one, null clears it (counts as 1 step).
    const estimate = b.estimate === undefined ? (existing?.estimate ?? null) : b.estimate;
    if (estimate !== null && (typeof estimate !== 'number' || !Number.isInteger(estimate) || estimate < 1 || estimate > 99)) throw bad('estimate must be a whole number from 1 to 99, or null');
    if (b.type !== 'task' && b.estimate != null) throw bad(`a${b.type === 'epic' ? 'n' : ''} ${b.type} cannot have an estimate; estimate its tasks`);
    const parent = parentId == null ? null : (db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(parentId, P()) as any);
    if (parentId != null && !parent) throw notFound('Parent issue');
    if (ownerId != null && !db.prepare('SELECT 1 FROM owners WHERE id = ? AND project_id = ?').get(ownerId, P())) throw notFound('Owner');
    // A task is only assigned to one of its module's owners, so it needs a module first (unchanged legacy values are tolerated).
    if (ownerId != null && !(existing && existing.owner_id === ownerId && existing.module_id === moduleId)) {
      if (moduleId == null) throw bad('set the module before the assignee');
      if (!db.prepare('SELECT 1 FROM module_owners WHERE module_id = ? AND owner_id = ?').get(moduleId, ownerId)) throw bad('the assignee must be an owner of the task\'s module');
    }
    if (moduleId != null && !db.prepare('SELECT 1 FROM modules WHERE id = ? AND project_id = ?').get(moduleId, P())) throw notFound('Module');
    if (existing) {
      for (let p = parent; p; p = p.parent_id == null ? null : db.prepare('SELECT * FROM issues WHERE id = ?').get(p.parent_id)) {
        if (p.id === existing.id) throw bad('parentId would create a cycle');
      }
    }
    if (parent && !PARENTS[type].includes(parent.type)) {
      throw bad(PARENTS[type].length ? `a ${type} parent must be ${PARENTS[type].map((t) => (/^[aeiou]/.test(t) ? `an ${t}` : `a ${t}`)).join(' or ')}` : `an ${type} cannot have a parent`);
    }
    if (existing) {
      const kids = db.prepare('SELECT type FROM issues WHERE parent_id = ?').all(existing.id) as { type: string }[];
      if (kids.some((k) => !PARENTS[k.type].includes(type))) throw bad(`type ${type} is incompatible with existing child issues`);
    }
    return { type, title, description: (b.description as string | undefined) ?? '', parentId, ownerId, moduleId, sprintId, state, estimate: b.type === 'task' ? (estimate as number | null) : null };
  };

  app.get('/api/issues', async () => issuePayloads());
  app.post('/api/issues', async (req, reply) => {
    const i = parseIssue(obj(req.body), null);
    const r = db.prepare('INSERT INTO issues (project_id, type, title, description, parent_id, owner_id, module_id, sprint_id, state, estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(P(), i.type, i.title, i.description, i.parentId, i.ownerId, i.moduleId, i.sprintId, i.state, i.estimate);
    joinedRunningSprint(i.sprintId);
    return reply.status(201).send(getIssue(Number(r.lastInsertRowid)));
  });
  // A task that lands in a sprint that is already running gets an owner straight away (same rules as starting it).
  const joinedRunningSprint = (sprintId: number | null) => {
    if (sprintId != null && (db.prepare('SELECT state FROM sprints WHERE id = ? AND project_id = ?').get(sprintId, P()) as any)?.state === 'active') balanceOwners(sprintId);
  };
  app.get('/api/issues/:id', async (req) => getIssue(id((req.params as any).id)));
  // Picks the best owner for one task with the sprint-balancing rules (it must be an open task in a sprint, with a module that has owners).
  app.post('/api/issues/:id/assign', async (req) => {
    const iid = id((req.params as any).id);
    const row = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P()) as any;
    if (!row) throw notFound('Issue');
    if (row.type !== 'task' || row.state !== 'open') throw bad('only an open task can be assigned');
    if (row.sprint_id == null) throw bad('add the task to a sprint first; owners are balanced within a sprint');
    if (row.module_id == null) throw bad('set the task\'s module first');
    if (!db.prepare('SELECT 1 FROM module_owners WHERE module_id = ?').get(row.module_id)) throw bad('the task\'s module has no owners yet');
    if (row.owner_id == null) balanceOwners(row.sprint_id, iid);
    return getIssue(iid);
  });
  app.put('/api/issues/:id', async (req) => {
    const iid = id((req.params as any).id);
    const existing = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P()) as any;
    if (!existing) throw notFound('Issue');
    const i = parseIssue(obj(req.body), existing);
    db.prepare('UPDATE issues SET type = ?, title = ?, description = ?, parent_id = ?, owner_id = ?, module_id = ?, sprint_id = ?, state = ?, estimate = ? WHERE id = ?')
      .run(i.type, i.title, i.description, i.parentId, i.ownerId, i.moduleId, i.sprintId, i.state, i.estimate, iid);
    if (i.sprintId !== existing.sprint_id) joinedRunningSprint(i.sprintId); // only on entering, so a deliberate "unassigned" sticks
    return getIssue(iid);
  });
  app.delete('/api/issues/:id', async (req, reply) => {
    const iid = id((req.params as any).id);
    getIssue(iid);
    db.prepare('DELETE FROM issues WHERE id = ?').run(iid);
    return reply.status(204).send();
  });


  const SPRINT_STATES = ['planned', 'active', 'closed'];
  const sprintPayloads = (rows: any[]) => {
    const bySprint = new Map<number, { id: number; state: string }[]>();
    for (const i of db.prepare('SELECT id, state, sprint_id FROM issues WHERE project_id = ? AND sprint_id IS NOT NULL ORDER BY id').all(P()) as any[]) {
      bySprint.set(i.sprint_id, [...(bySprint.get(i.sprint_id) ?? []), i]);
    }
    return rows.map((r) => {
    const issues = bySprint.get(r.id) ?? [];
    return {
      id: r.id, name: r.name, goal: r.goal, state: r.state,
      issueIds: issues.map((i) => i.id),
      openCount: issues.filter((i) => i.state === 'open').length,
      closedCount: issues.filter((i) => i.state === 'closed').length,
    };
    });
  };
  const getSprint = (sid: number) => {
    const r = db.prepare('SELECT * FROM sprints WHERE id = ? AND project_id = ?').get(sid, P());
    if (!r) throw notFound('Sprint');
    return sprintPayloads([r])[0];
  };
  // existing = the sprint being updated (null on create). Only one sprint may be active; closing sends
  // the sprint's unfinished (open) issues back to the backlog, closed ones stay as its history.
  const parseSprint = (b: Body, existing: any | null) => {
    const name = str(b.name, 'name');
    if (b.goal !== undefined && typeof b.goal !== 'string') throw bad('goal must be a string');
    const state = b.state === undefined ? (existing?.state ?? 'planned') : b.state;
    if (typeof state !== 'string' || !SPRINT_STATES.includes(state)) throw bad(`state must be one of ${SPRINT_STATES.join(', ')}`);
    const from = existing?.state ?? 'planned';
    if (from === 'closed' && state !== 'closed') throw bad('a closed sprint cannot be reopened');
    if (from === 'active' && state === 'planned') throw bad('an active sprint cannot go back to planned');
    if (state === 'active') {
      const other = db.prepare("SELECT id, name FROM sprints WHERE state = 'active' AND id != ? AND project_id = ?").get(existing?.id ?? -1, P()) as { id: number; name: string } | undefined;
      if (other) throw new HttpError(409, 'conflict', `sprint "${other.name}" is already active; close it first`);
    }
    return { name, goal: (b.goal as string | undefined) ?? existing?.goal ?? '', state };
  };

  app.get('/api/sprints', async () => sprintPayloads(db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY id').all(P())));
  app.post('/api/sprints', async (req, reply) => {
    const sp = parseSprint(obj(req.body), null);
    if (sp.state === 'closed') throw bad('a new sprint cannot start closed');
    const r = db.prepare('INSERT INTO sprints (project_id, name, goal, state) VALUES (?, ?, ?, ?)')
      .run(P(), sp.name, sp.goal, sp.state);
    return reply.status(201).send(getSprint(Number(r.lastInsertRowid)));
  });
  app.get('/api/sprints/:id', async (req) => getSprint(id((req.params as any).id)));
  // Gives every unassigned open task of a sprint an owner, balancing the team. Rules:
  //  1. only the task's own module owners may take it (no module / no owners: left alone);
  //  2. least-loaded owner wins, counting what each already carries in this sprint;
  //  3. continuity: whoever already holds a task of the same module counts as 2 lighter, so a module's tasks tend to stay
  //     with one person (about 3 in a row), and a task under the same epic/bug counts as 0.5 lighter;
  //  4. fairness cap: nobody goes above the sprint average (rounded up) + 1 while someone else in the pool is below it;
  //  5. narrowest choices are placed first, ties go to the lowest owner id, existing assignments are never moved.
  const balanceOwners = (sid: number, onlyId?: number) => {
    const rows = db.prepare("SELECT id, owner_id, module_id, parent_id FROM issues WHERE sprint_id = ? AND type = 'task' AND state = 'open' ORDER BY id").all(sid) as any[];
    const ofModule = new Map<number, number[]>();
    for (const r of db.prepare('SELECT module_id, owner_id FROM module_owners ORDER BY owner_id').all() as any[]) ofModule.set(r.module_id, [...(ofModule.get(r.module_id) ?? []), r.owner_id]);
    const pool = (r: any): number[] => (r.module_id == null ? [] : (ofModule.get(r.module_id) ?? []));
    const todo = rows.filter((r) => r.owner_id == null && pool(r).length > 0 && (onlyId == null || r.id === onlyId));
    if (todo.length === 0) return;
    const people = new Set(rows.flatMap((r) => (r.owner_id != null ? [r.owner_id] : pool(r))));
    const cap = Math.ceil(rows.length / people.size) + 1;
    const load = new Map<number, number>();
    const inModule = new Map<string, number>(); // owner:module -> tasks held
    const inParent = new Map<string, number>(); // owner:parent -> tasks held
    const note = (o: number, r: any) => {
      load.set(o, (load.get(o) ?? 0) + 1);
      if (r.module_id != null) inModule.set(`${o}:${r.module_id}`, (inModule.get(`${o}:${r.module_id}`) ?? 0) + 1);
      if (r.parent_id != null) inParent.set(`${o}:${r.parent_id}`, (inParent.get(`${o}:${r.parent_id}`) ?? 0) + 1);
    };
    rows.forEach((r) => { if (r.owner_id != null) note(r.owner_id, r); });
    const score = (o: number, r: any) => (load.get(o) ?? 0) - (inModule.get(`${o}:${r.module_id}`) ? 2 : 0) - (r.parent_id != null && inParent.get(`${o}:${r.parent_id}`) ? 0.5 : 0);
    const set = db.prepare('UPDATE issues SET owner_id = ? WHERE id = ?');
    todo.sort((a, b) => pool(a).length - pool(b).length || (a.module_id ?? 0) - (b.module_id ?? 0) || a.id - b.id).forEach((r) => {
      const open = pool(r).filter((o) => (load.get(o) ?? 0) < cap);
      const pick = [...(open.length ? open : pool(r))].sort((x, y) => score(x, r) - score(y, r) || x - y)[0];
      note(pick, r);
      set.run(pick, r.id);
    });
  };
  // Assigns every unassigned task of the sprint that can be assigned (rules as above).
  app.post('/api/sprints/:id/assign', async (req) => {
    const sid = id((req.params as any).id);
    getSprint(sid);
    // ?reset=1 starts over: open tasks whose module has owners are cleared first, so everything is dealt out afresh.
    if ((req.query as any)?.reset === '1') {
      db.prepare(`UPDATE issues SET owner_id = NULL WHERE sprint_id = ? AND type = 'task' AND state = 'open'
        AND module_id IN (SELECT module_id FROM module_owners)`).run(sid);
    }
    balanceOwners(sid);
    return getSprint(sid);
  });
  app.put('/api/sprints/:id', async (req) => {
    const sid = id((req.params as any).id);
    const existing = db.prepare('SELECT * FROM sprints WHERE id = ? AND project_id = ?').get(sid, P()) as any;
    if (!existing) throw notFound('Sprint');
    const sp = parseSprint(obj(req.body), existing);
    db.transaction(() => {
      db.prepare('UPDATE sprints SET name = ?, goal = ?, state = ? WHERE id = ?')
        .run(sp.name, sp.goal, sp.state, sid);
      if (sp.state === 'active' && existing.state !== 'active') balanceOwners(sid);
      if (sp.state === 'closed' && existing.state !== 'closed') {
        db.prepare("UPDATE issues SET sprint_id = NULL WHERE sprint_id = ? AND state = 'open'").run(sid);
      }
    })();
    return getSprint(sid);
  });
  app.delete('/api/sprints/:id', async (req, reply) => {
    const sid = id((req.params as any).id);
    getSprint(sid);
    db.prepare('DELETE FROM sprints WHERE id = ?').run(sid);
    return reply.status(204).send();
  });

  // ---- Projects ----
  const projectRow = (r: any) => {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).get(r.id) as { n: number }).n;
    return { id: r.id, name: r.name, description: r.description, createdAt: r.created_at, moduleCount: n('modules'), issueCount: n('issues'), sprintCount: n('sprints') };
  };
  const getProject = (pid: number) => {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!r) throw notFound('Project');
    return projectRow(r);
  };
  const parseProject = (b: Body, existing?: any) => {
    const name = str(b.name, 'name');
    if (name.length > 200) throw bad('name must be at most 200 characters');
    if (b.description !== undefined && typeof b.description !== 'string') throw bad('description must be a string');
    return { name, description: (b.description as string | undefined) ?? existing?.description ?? '' };
  };
  const projectNameTaken = (name: string, exceptId = 0) =>
    (db.prepare('SELECT name FROM projects WHERE id <> ?').all(exceptId) as { name: string }[]).some((r) => r.name.toLowerCase() === name.toLowerCase());
  const freeProjectName = (name: string) => {
    if (!projectNameTaken(name)) return name;
    for (let n = 2; ; n++) if (!projectNameTaken(`${name} (${n})`)) return `${name} (${n})`;
  };

  app.get('/api/projects', async () => (db.prepare('SELECT * FROM projects ORDER BY id').all() as any[]).map(projectRow));
  app.post('/api/projects', async (req, reply) => {
    const p = parseProject(obj(req.body));
    if (projectNameTaken(p.name)) throw new HttpError(409, 'conflict', 'A project with this name already exists');
    const r = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(p.name, p.description);
    return reply.status(201).send(getProject(Number(r.lastInsertRowid)));
  });
  app.get('/api/projects/:id', async (req) => getProject(id((req.params as any).id)));
  app.put('/api/projects/:id', async (req) => {
    const pid = id((req.params as any).id);
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!existing) throw notFound('Project');
    const p = parseProject(obj(req.body), existing);
    if (projectNameTaken(p.name, pid)) throw new HttpError(409, 'conflict', 'A project with this name already exists');
    db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(p.name, p.description, pid);
    return getProject(pid);
  });
  app.delete('/api/projects/:id', async (req, reply) => {
    const pid = id((req.params as any).id);
    getProject(pid);
    db.transaction(() => {
      // Children first: issues/sprints/modules reference each other and owners/groups.
      for (const t of ['issues', 'sprints', 'modules', 'groups', 'owners']) db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(pid);
      db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
    })();
    return reply.status(204).send();
  });

  // Export: one self-contained JSON file. Ids in the file are only labels for cross references; import remaps them.
  const FORMAT = 'pjplanner-project';
  app.get('/api/projects/:id/export', async (req, reply) => {
    const pid = id((req.params as any).id);
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as any;
    if (!proj) throw notFound('Project');
    const data = projectStore.run(pid, () => ({
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      project: { name: proj.name, description: proj.description },
      owners: ownerList(),
      groups: groupList(),
      modules: modules(),
      relations: relList(),
      sprints: (db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY id').all(pid) as any[]).map((s) => ({ id: s.id, name: s.name, goal: s.goal, state: s.state })),
      issues: (db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id').all(pid) as any[]).map((r) => ({
        id: r.id, type: r.type, title: r.title, description: r.description, state: r.state,
        parentId: r.parent_id ?? null, ownerId: r.owner_id ?? null, moduleId: r.module_id ?? null, sprintId: r.sprint_id ?? null, estimate: r.estimate ?? null,
      })),
    }));
    const file = proj.name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
    return reply.type('application/json').header('content-disposition', `attachment; filename="${file}.pjplanner.json"`).send(JSON.stringify(data, null, 2));
  });

  // Import always creates a new project (name gets " (2)" on a clash); nothing existing is touched.
  app.post('/api/projects/import', { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
    const b = obj(req.body);
    if (b.format !== FORMAT) throw bad('not a pjPlanner project file');
    if (b.version !== 1) throw bad(`unsupported project file version ${String(b.version)}`);
    const proj = obj(b.project);
    const list = (k: string): Body[] => {
      const v = b[k] ?? [];
      if (!Array.isArray(v)) throw bad(`${k} must be an array`);
      return v.map((x, i) => {
        const o = obj(x);
        if (!Number.isInteger(o.id)) throw bad(`${k}[${i}].id must be an integer`);
        return o;
      });
    };
    const owners = list('owners'), groups = list('groups'), mods = list('modules'), rels = list('relations'), sprints = list('sprints'), issues = list('issues');
    const name = str(proj.name, 'project.name');
    const description = typeof proj.description === 'string' ? proj.description : '';
    const mapOf = (rows: Body[]) => new Map<number, number>(rows.map((r) => [r.id as number, 0]));
    const ownerMap = mapOf(owners), groupMap = mapOf(groups), modMap = mapOf(mods), sprintMap = mapOf(sprints), issueMap = mapOf(issues);
    const ref = (m: Map<number, number>, v: unknown, what: string): number | null => {
      if (v === undefined || v === null) return null;
      const got = m.get(v as number);
      if (got === undefined) throw bad(`${what} refers to an unknown id ${String(v)}`);
      return got;
    };
    const pid = db.transaction(() => {
      const pid = Number(db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(freeProjectName(name.slice(0, 200)), description).lastInsertRowid);
      return projectStore.run(pid, () => {
        const oins = db.prepare('INSERT INTO owners (project_id, name, color, icon) VALUES (?, ?, ?, ?)');
        for (const o of owners) {
          const p = parseOwner(o);
          ownerMap.set(o.id as number, Number(oins.run(pid, p.name, p.color ?? null, p.icon ?? null).lastInsertRowid));
        }
        const gins = db.prepare('INSERT INTO groups (project_id, name, color, icon) VALUES (?, ?, ?, ?)');
        for (const g of groups) {
          const p = parseOwner(g);
          groupMap.set(g.id as number, Number(gins.run(pid, p.name, p.color ?? null, p.icon ?? null).lastInsertRowid));
        }
        // Parents are linked after every group exists, so file order does not matter; checkParent keeps depth and cycles valid.
        for (const g of groups) {
          const parent = ref(groupMap, g.parentId, `groups[${g.id}].parentId`);
          if (parent !== null) db.prepare('UPDATE groups SET parent_id = ? WHERE id = ?').run(checkParent(parent, groupMap.get(g.id as number)!), groupMap.get(g.id as number));
        }
        const mins = db.prepare('INSERT INTO modules (project_id, name, description, color, icon, text_color, stroke_color, stroke_style, x, y, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const m of mods) {
          const { ownerIds: _o, groupId: _g, ...rest } = m as any;
          const p = { name: str(m.name, 'module name'), description: typeof m.description === 'string' ? m.description : '', ...parseExtras({ ...rest, apiItems: (m.apiItems ?? []) as unknown[] }) };
          const x = typeof m.x === 'number' && Number.isFinite(m.x) ? m.x : null;
          const y = typeof m.y === 'number' && Number.isFinite(m.y) ? m.y : null;
          const mid = Number(mins.run(pid, p.name, p.description, p.color ?? null, p.icon ?? null, p.textColor ?? null, p.strokeColor ?? null, p.strokeStyle ?? 'solid', x, y,
            ref(groupMap, m.groupId, `modules[${m.id}].groupId`)).lastInsertRowid);
          modMap.set(m.id as number, mid);
          setItems(mid, (p.apiItems ?? []).map(({ id: _i, ...it }) => it));
          const oids = Array.isArray(m.ownerIds) ? m.ownerIds : [];
          setOwners(mid, [...new Set(oids.map((o) => {
            if (o === null || o === undefined) throw bad(`modules[${m.id}].ownerIds refers to an unknown id ${String(o)}`);
            return ref(ownerMap, o, `modules[${m.id}].ownerIds`)!;
          }))]);
        }
        const rins = db.prepare('INSERT INTO relations (source_id, target_id, label, color) VALUES (?, ?, ?, ?)');
        const seen = new Set<string>();
        for (const r of rels) {
          const s = ref(modMap, r.sourceId, 'relation sourceId'), t = ref(modMap, r.targetId, 'relation targetId');
          if (s === null || t === null || s === t) throw bad('relation needs two different modules');
          if (seen.has(`${s}:${t}`)) continue;
          seen.add(`${s}:${t}`);
          rins.run(s, t, labelOf(r.label), colorField(r, 'color') ?? null);
        }
        const sins = db.prepare('INSERT INTO sprints (project_id, name, goal, state) VALUES (?, ?, ?, ?)');
        let active = 0;
        for (const s of sprints) {
          const state = s.state === undefined ? 'planned' : s.state;
          if (typeof state !== 'string' || !SPRINT_STATES.includes(state)) throw bad(`sprints[${s.id}].state is invalid`);
          if (state === 'active' && ++active > 1) throw bad('only one sprint can be active');
          sprintMap.set(s.id as number, Number(sins.run(pid, str(s.name, 'sprint name'), typeof s.goal === 'string' ? s.goal : '', state).lastInsertRowid));
        }
        const iins = db.prepare('INSERT INTO issues (project_id, type, title, description, owner_id, module_id, sprint_id, state, estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const i of issues) {
          if (typeof i.type !== 'string' || !ISSUE_TYPES.includes(i.type)) throw bad(`issues[${i.id}].type is invalid`);
          const state = i.state === undefined ? 'open' : i.state;
          if (typeof state !== 'string' || !ISSUE_STATES.includes(state)) throw bad(`issues[${i.id}].state is invalid`);
          const task = i.type === 'task';
          issueMap.set(i.id as number, Number(iins.run(pid, i.type, str(i.title, 'issue title'), typeof i.description === 'string' ? i.description : '',
            task ? ref(ownerMap, i.ownerId, `issues[${i.id}].ownerId`) : null, task ? ref(modMap, i.moduleId, `issues[${i.id}].moduleId`) : null,
            task ? ref(sprintMap, i.sprintId, `issues[${i.id}].sprintId`) : null, state,
            task && Number.isInteger(i.estimate) && (i.estimate as number) >= 1 && (i.estimate as number) <= 99 ? (i.estimate as number) : null).lastInsertRowid));
        }
        for (const i of issues) {
          const parent = ref(issueMap, i.parentId, `issues[${i.id}].parentId`);
          if (parent === null) continue;
          const pType = (db.prepare('SELECT type FROM issues WHERE id = ?').get(parent) as { type: string }).type;
          if (!PARENTS[i.type as string].includes(pType)) throw bad(`issues[${i.id}] has an invalid parent type`);
          db.prepare('UPDATE issues SET parent_id = ? WHERE id = ?').run(parent, issueMap.get(i.id as number));
        }
        return pid;
      });
    })();
    return reply.status(201).send(getProject(pid));
  });

  const staticDir = path.resolve(process.env.STATIC_DIR ?? '../frontend/dist');
  const staticIndex = fs.existsSync(path.join(staticDir, 'index.html')) ? path.join(staticDir, 'index.html') : null;
  if (staticIndex) app.register(fastifyStatic, { root: staticDir });

  return app;
}
