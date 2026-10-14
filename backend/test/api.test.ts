import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { timing } from '../src/routes/issues.js';

let app: ReturnType<typeof buildApp>;
// A fresh database has no project; the suite works inside one called "Test" (the oldest, so no header is needed).
beforeEach(async () => {
  app = buildApp(':memory:');
  await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Test' } });
});

// Every task needs a module: a task created without a `moduleId` key gets a shared default one (pass `moduleId: null` to test the rule itself).
let defaultModule: number | null = null;
beforeEach(() => { defaultModule = null; });
const call = async (method: any, url: string, payload?: any) => {
  if (method === 'POST' && url === '/api/issues' && payload?.type === 'task' && !('moduleId' in payload)) {
    if (defaultModule == null) defaultModule = (await app.inject({ method: 'POST', url: '/api/modules', payload: { name: 'Default module' } })).json().id;
    payload = { ...payload, moduleId: defaultModule };
  }
  if (method === 'PUT' && /^\/api\/issues\/\d+$/.test(url) && payload?.type === 'task' && !('moduleId' in payload)) {
    const cur = (await app.inject({ method: 'GET', url })).json();
    payload = { ...payload, moduleId: cur.moduleId };
  }
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const mod = async (name: string, extra: any = {}) => (await call('POST', '/api/modules', { name, ...extra })).body;
const owner = async (name: string, _email?: string) => (await call('POST', '/api/owners', { name })).body;

describe('api', () => {
  it('health', async () => {
    expect((await call('GET', '/api/health')).body).toEqual({ status: 'ok' });
  });

  it('serves the MCP bundle as a download, 404 when not built', async () => {
    const f = path.join(os.tmpdir(), `mcp-${process.pid}.mjs`);
    fs.writeFileSync(f, 'console.log(1)');
    process.env.MCP_BUNDLE = f;
    const r = await app.inject({ method: 'GET', url: '/api/mcp/download' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('pjplanner-mcp.mjs');
    expect(r.body).toBe('console.log(1)');
    fs.rmSync(f);
    expect((await call('GET', '/api/mcp/download')).status).toBe(404);
    delete process.env.MCP_BUNDLE;
  });

  it('serves the skill suite: list, each skill, legacy mapping route, 404 when missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    for (const n of ['pjplanner-map', 'pjplanner-breakdown']) {
      fs.mkdirSync(path.join(dir, n));
      fs.writeFileSync(path.join(dir, n, 'SKILL.md'), `---\nname: ${n}\ndescription: does ${n}\n---\n# ${n}`);
    }
    fs.mkdirSync(path.join(dir, 'empty'));
    process.env.MCP_SKILLS = dir;
    const list = await call('GET', '/api/mcp/skills');
    expect(list.body).toEqual([{ name: 'pjplanner-breakdown', description: 'does pjplanner-breakdown' }, { name: 'pjplanner-map', description: 'does pjplanner-map' }]);
    expect((await app.inject({ method: 'GET', url: '/api/mcp/skills/pjplanner-breakdown' })).body).toContain('# pjplanner-breakdown');
    expect((await app.inject({ method: 'GET', url: '/api/mcp/skill' })).body).toContain('# pjplanner-map');
    expect((await call('GET', '/api/mcp/skills/..%2Fx')).status).toBe(404);
    expect((await call('GET', '/api/mcp/skills/empty')).status).toBe(404);
    fs.rmSync(dir, { recursive: true });
    expect((await call('GET', '/api/mcp/skill')).status).toBe(404);
    delete process.env.MCP_SKILLS;
  });

  it('with a write key set, every write needs it (UI and agents); reads stay open; unlock checks it', async () => {
    process.env.WRITE_KEY = 'secret';
    const send = (method: any, url: string, headers: any, payload?: any) => app.inject({ method, url, headers, payload }).then((r) => r.statusCode);
    expect(await send('POST', '/api/modules', { 'x-agent': 'mcp' }, { name: 'a' })).toBe(401);
    expect(await send('POST', '/api/modules', { 'x-agent': 'mcp', 'x-api-key': 'nope' }, { name: 'a' })).toBe(401);
    expect(await send('POST', '/api/modules', { 'x-agent': 'mcp', 'x-api-key': 'secret' }, { name: 'a' })).toBe(201);
    expect(await send('GET', '/api/graph', { 'x-agent': 'mcp' })).toBe(200);
    expect(await send('POST', '/api/modules', {}, { name: 'b' })).toBe(401); // the UI is locked too until it sends the key
    expect(await send('POST', '/api/modules', { 'x-api-key': 'secret' }, { name: 'b' })).toBe(201);
    expect(await send('POST', '/api/unlock', {})).toBe(401);
    expect(await send('POST', '/api/unlock', { 'x-api-key': 'nope' })).toBe(401);
    expect(await send('POST', '/api/unlock', { 'x-api-key': 'secret' })).toBe(200);
    expect((await call('GET', '/api/access')).body).toEqual({ locked: true });
    delete process.env.WRITE_KEY;
    expect((await call('GET', '/api/access')).body).toEqual({ locked: false });
    expect(await send('POST', '/api/modules', {}, { name: 'c' })).toBe(201); // no key configured: open
  });

  it('keeps a task that predates the module rule editable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'legacy.db');
    const a = buildApp(file);
    await a.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });
    const m = (await a.inject({ method: 'POST', url: '/api/modules', payload: { name: 'M' } })).json().id;
    await a.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: 'old', moduleId: m } });
    await a.close();
    const raw = new Database(file); raw.prepare('UPDATE issues SET module_id = NULL').run(); raw.close();
    const b = buildApp(file);
    const r = await b.inject({ method: 'PUT', url: '/api/issues/1', payload: { type: 'task', title: 'renamed', state: 'closed' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().moduleId).toBeNull();
    await b.close();
  });

  it('records when a task started, was closed (and by whom) and reopened', async () => {
    const o = await owner('O');
    const m = await mod('M', { ownerIds: [o.id] });
    const t = (await call('POST', '/api/issues', { type: 'task', title: 'T', moduleId: m.id, ownerId: o.id })).body;
    expect(t).toMatchObject({ startedAt: null, closedAt: null, reopenCount: 0 });
    const put = (state: string) => call('PUT', `/api/issues/${t.id}`, { type: 'task', title: 'T', moduleId: m.id, ownerId: o.id, state });
    const review = (await put('code_review')).body;
    expect(review.startedAt).toMatch(/Z$/);
    expect(review.closedAt).toBeNull();
    const closed = (await put('closed')).body;
    expect(closed).toMatchObject({ startedAt: review.startedAt, closedOwnerId: o.id });
    expect(closed.closedAt).toMatch(/Z$/);
    const reopened = (await put('open')).body;
    expect(reopened).toMatchObject({ closedAt: null, closedOwnerId: null, reopenCount: 1, startedAt: review.startedAt });
    expect((await put('closed')).body.closedAt).toMatch(/Z$/);
    // created already closed
    const done = (await call('POST', '/api/issues', { type: 'task', title: 'D', moduleId: m.id, state: 'closed' })).body;
    expect(done.closedAt).toMatch(/Z$/);
    expect(done.startedAt).toBeNull();
  });

  it('timing() only counts a real transition', () => {
    expect(timing({ state: 'open', started_at: null, closed_at: null, reopen_count: 0 }, 'open', null, 'T')).toMatchObject({ started: null, closedAt: null, reopens: 0 });
    expect(timing({ state: 'closed', closed_at: 'X', closed_owner_id: 1, reopen_count: 2 }, 'closed', 5, 'T')).toMatchObject({ closedAt: 'X', closedOwner: 1, reopens: 2 });
  });

  it('keeps implementation notes on tasks only, and keeps them when omitted on update', async () => {
    const t = (await call('POST', '/api/issues', { type: 'task', title: 'T', implementation: 'use the cache' })).body;
    expect(t.implementation).toBe('use the cache');
    const kept = (await call('PUT', `/api/issues/${t.id}`, { type: 'task', title: 'T2' })).body;
    expect(kept.implementation).toBe('use the cache');
    expect((await call('PUT', `/api/issues/${t.id}`, { type: 'task', title: 'T2', implementation: '' })).body.implementation).toBe('');
    expect((await call('POST', '/api/issues', { type: 'story', title: 'S', implementation: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/issues', { type: 'story', title: 'S' })).body.implementation).toBe('');
    expect((await call('POST', '/api/issues', { type: 'task', title: 'T', implementation: 5 })).status).toBe(400);
  });

  it('reports the address the caller reached the server at', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mcp/info', headers: { host: '192.168.1.9:3000' } });
    expect(res.json()).toEqual({ url: 'http://192.168.1.9:3000' });
  });

  it('reports the address agents should use', async () => {
    process.env.PUBLIC_URL = 'http://10.0.0.5:3030/';
    expect((await call('GET', '/api/mcp/info')).body).toEqual({ url: 'http://10.0.0.5:3030' });
    delete process.env.PUBLIC_URL;
    expect((await call('GET', '/api/mcp/info')).body.url).toMatch(/^http:\/\/[\d.]+:3030$|^http:\/\/localhost:3030$/);
  });

  describe('sprints', () => {
    const sp = (name: string, extra: any = {}) => call('POST', '/api/sprints', { name, ...extra });
    const issue = async (title: string, extra: any = {}) => (await call('POST', '/api/issues', { type: 'task', title, ...extra })).body;

    it('balances unassigned tasks across owners when the sprint starts', async () => {
      const o = async (n: string) => (await call('POST', '/api/owners', { name: n })).body.id;
      const [a, b, c] = [await o('A'), await o('B'), await o('C')];
      const m = (await call('POST', '/api/modules', { name: 'M', ownerIds: [a, b] })).body.id;
      const s = (await sp('S')).body.id;
      const mine = await issue('keep', { sprintId: s, moduleId: m, ownerId: a });
      const t = [await issue('t1', { sprintId: s, moduleId: m }), await issue('t2', { sprintId: s, moduleId: m }), await issue('t3', { sprintId: s })];
      const outside = await issue('outside', { moduleId: m });
      expect((await call('PUT', `/api/sprints/${s}`, { name: 'S', state: 'active' })).status).toBe(200);
      const owner = async (i: any) => (await call('GET', `/api/issues/${i.id}`)).body.ownerId;
      expect(await owner(mine)).toBe(a);
      expect([await owner(t[0]), await owner(t[1])]).toEqual([a, a]); // module owners only, and the module's tasks stay with one person
      expect(await owner(t[2])).toBeNull(); // no module: nobody may take it
      expect(c).toBeGreaterThan(0);
      expect(await owner(outside)).toBeNull(); // not in the sprint
    });

    it('assigns an owner to a task added to a sprint that is already running', async () => {
      const a = (await call('POST', '/api/owners', { name: 'A' })).body.id;
      const b = (await call('POST', '/api/owners', { name: 'B' })).body.id;
      const m = (await call('POST', '/api/modules', { name: 'M', ownerIds: [a, b] })).body.id;
      const s = (await sp('S')).body.id;
      await call('PUT', `/api/sprints/${s}`, { name: 'S', state: 'active' });
      const t1 = await issue('t1', { sprintId: s, moduleId: m });
      const t2 = await issue('t2', { sprintId: s, moduleId: m });
      expect([a, b]).toContain(t1.ownerId);
      expect(t2.ownerId).toBe(t1.ownerId); // same module, same person
      const t3 = await issue('t3', { moduleId: m });
      expect(t3.ownerId).toBeNull();
      const put = await call('PUT', `/api/issues/${t3.id}`, { type: 'task', title: 't3', moduleId: m, sprintId: s });
      expect([a, b]).toContain(put.body.ownerId);
      const keep = await call('PUT', `/api/issues/${t1.id}`, { type: 'task', title: 't1', moduleId: m, ownerId: null }); // deliberate unassign sticks
      expect(keep.body.ownerId).toBeNull();
    });

    it('keeps a module\'s tasks with one owner, then spreads the rest evenly', async () => {
      const a = (await call('POST', '/api/owners', { name: 'A' })).body.id;
      const b = (await call('POST', '/api/owners', { name: 'B' })).body.id;
      const m = (await call('POST', '/api/modules', { name: 'M', ownerIds: [a, b] })).body.id;
      const s = (await sp('S')).body.id;
      const ts = [];
      for (let k = 1; k <= 5; k++) ts.push(await issue(`t${k}`, { sprintId: s, moduleId: m }));
      await call('PUT', `/api/sprints/${s}`, { name: 'S', state: 'active' });
      const owners = await Promise.all(ts.map(async (t) => (await call('GET', `/api/issues/${t.id}`)).body.ownerId));
      expect(owners.slice(0, 3)).toEqual([a, a, a]); // same person for the first three
      expect(owners.slice(3).every((o) => o === b)).toBe(true); // the rest go to the other owner
    });

    it('auto-assigns one task or a whole sprint on request', async () => {
      const a = (await call('POST', '/api/owners', { name: 'A' })).body.id;
      const m = (await call('POST', '/api/modules', { name: 'M', ownerIds: [a] })).body.id;
      const bare = (await call('POST', '/api/modules', { name: 'B' })).body.id;
      const s = (await sp('S')).body.id;
      const t = await issue('t', { sprintId: s, moduleId: m });
      const u = await issue('u', { sprintId: s, moduleId: m });
      const noOwners = await issue('n', { sprintId: s, moduleId: bare });
      const backlog = await issue('b', { moduleId: m });
      expect((await call('POST', `/api/issues/${backlog.id}/assign`)).status).toBe(400); // not in a sprint
      expect((await call('POST', `/api/issues/${noOwners.id}/assign`)).body.error.message).toMatch(/no owners/);
      expect((await call('POST', `/api/issues/${t.id}/assign`)).body.ownerId).toBe(a);
      expect((await call('GET', `/api/issues/${u.id}`)).body.ownerId).toBeNull(); // only the one asked for
      expect((await call('POST', `/api/sprints/${s}/assign`)).status).toBe(200);
      expect((await call('GET', `/api/issues/${u.id}`)).body.ownerId).toBe(a);
      // re-assign: clears and deals again; a removed owner no longer holds anything
      const b = (await call('POST', '/api/owners', { name: 'B' })).body.id;
      await call('PUT', `/api/modules/${m}`, { name: 'M', ownerIds: [b] });
      expect((await call('POST', `/api/sprints/${s}/assign?reset=1`)).status).toBe(200);
      expect((await call('GET', `/api/issues/${u.id}`)).body.ownerId).toBe(b);
    });

    it('keeps bugs and epics out of sprints', async () => {
      const s = (await sp('S')).body.id;
      expect((await call('POST', '/api/issues', { type: 'bug', title: 'B', sprintId: s })).status).toBe(400);
      expect((await call('POST', '/api/issues', { type: 'bug', title: 'B' })).status).toBe(201);
    });

    it('creates and lists with counts', async () => {
      const r = await sp('S1', { goal: 'ship it' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ name: 'S1', goal: 'ship it', state: 'planned', issueIds: [], openCount: 0, closedCount: 0 });
      expect((await sp('', {})).status).toBe(400);
      expect((await call('GET', '/api/sprints')).body).toHaveLength(1);
      expect((await call('GET', '/api/sprints/99')).status).toBe(404);
    });

    it('allows only one active sprint', async () => {
      const a = (await sp('A')).body; const b = (await sp('B')).body;
      const put = (s: any, state: string) => call('PUT', `/api/sprints/${s.id}`, { name: s.name, state });
      expect((await put(a, 'active')).status).toBe(200);
      expect((await put(b, 'active')).status).toBe(409);
      expect((await put(a, 'closed')).status).toBe(200);
      expect((await put(b, 'active')).status).toBe(200);
      expect((await put(a, 'planned')).status).toBe(400); // closed cannot reopen
      expect((await put(b, 'planned')).status).toBe(400); // active cannot go back
    });

    it('assigns issues; omitted sprintId keeps it, null clears; closing returns open issues to the backlog', async () => {
      const s = (await sp('S')).body;
      const done = await issue('done', { sprintId: s.id, state: 'closed' });
      const todo = await issue('todo', { sprintId: s.id });
      expect(todo.sprintId).toBe(s.id);
      const kept = await call('PUT', `/api/issues/${todo.id}`, { type: 'task', title: 'renamed' });
      expect(kept.body.sprintId).toBe(s.id);
      expect((await call('GET', `/api/sprints/${s.id}`)).body).toMatchObject({ issueIds: [done.id, todo.id], openCount: 1, closedCount: 1 });
      await call('PUT', `/api/sprints/${s.id}`, { name: 'S', state: 'closed' });
      expect((await call('GET', `/api/issues/${todo.id}`)).body.sprintId).toBeNull();
      expect((await call('GET', `/api/issues/${done.id}`)).body.sprintId).toBe(s.id);
      expect((await call('POST', '/api/issues', { type: 'task', title: 'x', sprintId: s.id })).status).toBe(400); // closed
      expect((await call('POST', '/api/issues', { type: 'task', title: 'x', sprintId: 999 })).status).toBe(404);
      const cleared = await call('PUT', `/api/issues/${done.id}`, { type: 'task', title: 'done', state: 'closed', sprintId: null });
      expect(cleared.body.sprintId).toBeNull();
    });

    it('epics only group issues and cannot be put in a sprint', async () => {
      const s = (await sp('S')).body;
      expect((await call('POST', '/api/issues', { type: 'epic', title: 'E', sprintId: s.id })).status).toBe(400);
      const e = await issue('E2', { type: 'epic' });
      expect(e.sprintId).toBeNull();
      const child = await issue('child', { parentId: e.id, sprintId: s.id });
      expect(child.sprintId).toBe(s.id);
      expect((await call('PUT', `/api/issues/${e.id}`, { type: 'epic', title: 'E2', sprintId: s.id })).status).toBe(400);
    });

    it('deleting a sprint moves its issues to the backlog', async () => {
      const s = (await sp('S')).body;
      const i = await issue('i', { sprintId: s.id });
      expect((await call('DELETE', `/api/sprints/${s.id}`)).status).toBe(204);
      expect((await call('GET', `/api/issues/${i.id}`)).body.sprintId).toBeNull();
    });
  });

  it('module CRUD with defaults and owner replacement', async () => {
    const o1 = await owner('A', 'a@x.com');
    const o2 = await owner('B', 'b@x.com');
    const r = await call('POST', '/api/modules', { name: 'M', ownerIds: [o1.id] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'M', description: '', ownerIds: [o1.id] });
    expect(r.body).not.toHaveProperty('status');
    const put = await call('PUT', `/api/modules/${r.body.id}`, { name: 'M2', description: 'd', status: 'done', ownerIds: [o2.id] });
    expect(put.body).toMatchObject({ name: 'M2', ownerIds: [o2.id] });
    expect(put.body).not.toHaveProperty('status');
    expect((await call('GET', `/api/modules/${r.body.id}`)).status).toBe(200);
    expect((await call('GET', '/api/graph')).body.modules).toHaveLength(1);
  });

  it('validates modules', async () => {
    expect((await call('POST', '/api/modules', { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/modules', { name: 'x', status: 'nope' })).status).toBe(201);
    const r = await call('POST', '/api/modules', { name: 'x', ownerIds: [99] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect((await call('GET', '/api/modules/99')).status).toBe(404);
    expect((await call('PUT', '/api/modules/99', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/modules/99')).status).toBe(404);
  });

  it('owner color/icon, validation and name conflicts', async () => {
    const r = await call('POST', '/api/owners', { name: ' A ', color: '#AABBCC', icon: ' 🙂 ', email: 'ignored@x.com' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: r.body.id, name: 'A', color: '#aabbcc', icon: '🙂' });
    const id = r.body.id;
    expect((await call('PUT', `/api/owners/${id}`, { name: 'A2' })).body).toEqual({ id, name: 'A2', color: '#aabbcc', icon: '🙂' });
    expect((await call('PUT', `/api/owners/${id}`, { name: 'A2', color: null, icon: null })).body).toEqual({ id, name: 'A2', color: null, icon: null });
    for (const bad of [{ name: '' }, { name: 'x'.repeat(201) }, { name: 'x', color: 'red' }, { name: 'x', icon: '' }, { name: 'x', icon: '123456789' }, { name: 'x', icon: 5 }]) {
      const e = await call('POST', '/api/owners', bad);
      expect(e.status).toBe(400);
      expect(e.body.error.code).toBe('validation_error');
    }
    expect((await call('POST', '/api/owners', { name: 'a2' })).status).toBe(409);
    const b = await owner('B');
    expect((await call('PUT', `/api/owners/${b.id}`, { name: 'A2' })).status).toBe(409);
    expect((await call('PUT', `/api/owners/${id}`, { name: 'a2' })).status).toBe(200);
    expect((await call('PUT', '/api/owners/99', { name: 'Z' })).status).toBe(404);
    expect((await call('GET', '/api/graph')).body.owners[0]).toEqual({ id, name: 'a2', color: null, icon: null });
  });

  it('migrates owners with email, keeping ids and module links, idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjp-'));
    const file = path.join(dir, 'old.db');
    const d = new Database(file);
    d.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
      CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
      CREATE TABLE module_owners (module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE, PRIMARY KEY (module_id, owner_id));
      INSERT INTO modules (name) VALUES ('M');
      INSERT INTO owners (name, email) VALUES ('One', 'one@x.com'), ('Two', 'two@x.com');
      INSERT INTO module_owners VALUES (1, 1), (1, 2);
    `);
    d.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const g = (await a.inject({ method: 'GET', url: '/api/graph' })).json();
      expect(g.owners).toEqual([{ id: 1, name: 'One', color: null, icon: null }, { id: 2, name: 'Two', color: null, icon: null }]);
      expect(g.modules[0].ownerIds).toEqual([1, 2]);
      await a.close();
    }
    const a = buildApp(file);
    expect((await a.inject({ method: 'DELETE', url: '/api/owners/1' })).statusCode).toBe(204);
    const g = (await a.inject({ method: 'GET', url: '/api/graph' })).json();
    expect(g.modules[0].ownerIds).toEqual([2]);
    expect(g.modules).toHaveLength(1);
    await a.close();
  });

  it('deleting an owner only unassigns', async () => {
    const o = await owner('A', 'a@x.com');
    const m = await mod('M', { ownerIds: [o.id] });
    expect((await call('DELETE', `/api/owners/${o.id}`)).status).toBe(204);
    expect((await call('GET', `/api/modules/${m.id}`)).body.ownerIds).toEqual([]);
    expect((await call('GET', '/api/owners')).body).toEqual([]);
  });

  it('relations: create, update, reject self/duplicate/unknown, cascade on module delete', async () => {
    const a = await mod('A');
    const b = await mod('B');
    const r = await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id });
    expect(r.status).toBe(201);
    expect(r.body.label).toBeNull();
    expect((await call('POST', '/api/relations', { sourceId: a.id, targetId: a.id })).status).toBe(400);
    expect((await call('POST', '/api/relations', { sourceId: a.id, targetId: 99 })).status).toBe(400);
    expect((await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id })).status).toBe(409);
    expect((await call('POST', '/api/relations', { sourceId: b.id, targetId: a.id })).status).toBe(201);
    expect((await call('PUT', `/api/relations/${r.body.id}`, { label: 'uses' })).body.label).toBe('uses');
    expect((await call('PUT', '/api/relations/99', { label: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/api/modules/${a.id}`)).status).toBe(204);
    expect((await call('GET', '/api/graph')).body.relations).toEqual([]);
    expect((await call('DELETE', '/api/relations/99')).status).toBe(404);
  });

  it('deletes a relation', async () => {
    const a = await mod('A');
    const b = await mod('B');
    const r = await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id, label: 'x' });
    expect((await call('DELETE', `/api/relations/${r.body.id}`)).status).toBe(204);
    expect((await call('GET', '/api/relations')).body).toEqual([]);
  });

  it('wraps framework errors in the error envelope', async () => {
    const notJson = await app.inject({ method: 'POST', url: '/api/modules', payload: 'x', headers: { 'content-type': 'application/xml' } });
    expect(notJson.statusCode).toBe(415);
    expect(notJson.json().error.code).toBe('validation_error');
    const malformed = await app.inject({ method: 'POST', url: '/api/modules', payload: '{bad', headers: { 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.message).toBeTruthy();
    const missing = await call('GET', '/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });
});

describe('module visuals and api items', () => {
  const it3 = [
    { kind: 'function', name: 'f', signature: 'f()', description: 'd' },
    { kind: 'endpoint', name: 'e' },
    { name: 'o' },
  ];

  it('creates with color, icon and items', async () => {
    const m = await mod('M', { color: '#AABBCC', icon: ' 🚀 ', apiItems: it3 });
    expect(m.color).toBe('#aabbcc');
    expect(m.icon).toBe('🚀');
    expect(m.apiItems.map((i: any) => [i.kind, i.name, i.signature])).toEqual([['function', 'f', 'f()'], ['endpoint', 'e', ''], ['other', 'o', '']]);
    const plain = await mod('P');
    expect(plain).toMatchObject({ color: null, icon: null, apiItems: [] });
    const g = (await call('GET', '/api/graph')).body;
    expect(g.modules[0].apiItems).toHaveLength(3);
  });

  it('PUT replaces, keeps by id, deletes by omission, reorders', async () => {
    const m = await mod('M', { apiItems: it3 });
    const [a, b, c] = m.apiItems;
    const r = await call('PUT', `/api/modules/${m.id}`, { name: 'M', apiItems: [{ id: c.id, kind: 'type', name: 'c2' }, { id: a.id, name: 'a' }, { name: 'new' }] });
    expect(r.status).toBe(200);
    expect(r.body.apiItems.map((i: any) => i.name)).toEqual(['c2', 'a', 'new']);
    expect(r.body.apiItems[0]).toMatchObject({ id: c.id, kind: 'type' });
    expect(r.body.apiItems[1].id).toBe(a.id);
    expect(r.body.apiItems.some((i: any) => i.id === b.id)).toBe(false);
    const e = await call('PUT', `/api/modules/${m.id}`, { name: 'M', apiItems: [] });
    expect(e.body.apiItems).toEqual([]);
  });

  it('PUT omitting new fields leaves them; null clears', async () => {
    const m = await mod('M', { color: '#112233', icon: 'x', apiItems: it3 });
    const r = (await call('PUT', `/api/modules/${m.id}`, { name: 'M2' })).body;
    expect(r).toMatchObject({ name: 'M2', color: '#112233', icon: 'x' });
    expect(r.apiItems).toHaveLength(3);
    const c = (await call('PUT', `/api/modules/${m.id}`, { name: 'M2', color: null, icon: null })).body;
    expect(c).toMatchObject({ color: null, icon: null });
  });

  it('rejects invalid input with 400', async () => {
    const m = await mod('M', { apiItems: [{ name: 'a' }] });
    const other = await mod('O', { apiItems: [{ name: 'z' }] });
    const cases: any[] = [
      { color: 'red' }, { color: '#abc' }, { color: 5 }, { icon: '' }, { icon: '   ' }, { icon: '123456789' }, { icon: 3 },
      { apiItems: 'x' }, { apiItems: [{ kind: 'bogus', name: 'a' }] }, { apiItems: [{ name: ' ' }] }, { apiItems: [{}] },
      { apiItems: [{ name: 'a'.repeat(201) }] }, { apiItems: [{ name: 'a', signature: 's'.repeat(1001) }] },
      { apiItems: [{ name: 'a', description: 'd'.repeat(5001) }] }, { apiItems: [{ id: 'x', name: 'a' }] },
      { apiItems: [{ id: 9999, name: 'a' }] }, { apiItems: [{ id: other.apiItems[0].id, name: 'a' }] },
    ];
    for (const extra of cases) {
      for (const [method, url] of [['POST', '/api/modules'], ['PUT', `/api/modules/${m.id}`]]) {
        const r = await call(method, url, { name: 'N', ...extra });
        expect(r.status, JSON.stringify(extra)).toBe(400);
        expect(r.body.error.code).toBe('validation_error');
      }
    }
    expect((await call('GET', `/api/modules/${m.id}`)).body.apiItems).toHaveLength(1);
    expect((await call('GET', `/api/modules/${other.id}`)).body.apiItems[0].name).toBe('z');
  });

  it('delete cascades items', async () => {
    const m = await mod('M', { apiItems: it3 });
    await call('DELETE', `/api/modules/${m.id}`);
    const db = (app as any);
    const n = await mod('N', { apiItems: [{ name: 'k' }] });
    expect(n.apiItems[0].id).toBeGreaterThan(m.apiItems[2].id);
    expect((await call('GET', '/api/graph')).body.modules).toHaveLength(1);
    void db;
  });

  it('migrates a v1 database idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'v1.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done')));
      CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
      CREATE TABLE module_owners (module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE, PRIMARY KEY (module_id, owner_id));
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, label TEXT, UNIQUE (source_id, target_id), CHECK (source_id <> target_id));
      INSERT INTO modules (name, description, status) VALUES ('A', 'da', 'done'), ('B', '', 'planned');
      INSERT INTO owners (name, email) VALUES ('O', 'o@x.com');
      INSERT INTO module_owners VALUES (1, 1);
      INSERT INTO relations (source_id, target_id, label) VALUES (1, 2, 'uses');
    `);
    raw.close();
    for (let round = 0; round < 2; round++) {
      const a = buildApp(file);
      const g = (await a.inject({ method: 'GET', url: '/api/graph' })).json();
      expect(g.modules[0]).toEqual({ id: 1, name: 'A', description: 'da', ownerIds: [1], color: null, icon: null, textColor: null, strokeColor: null, strokeStyle: 'solid', testStatus: null, testNotes: '', x: null, y: null, groupId: null, apiItems: [] });
      expect(g.modules).toHaveLength(2);
      expect(g.relations).toHaveLength(1);
      if (round === 0) {
        const r = await a.inject({ method: 'PUT', url: '/api/modules/2', payload: { name: 'B', icon: '🔥', apiItems: [{ name: 'x' }] } });
        expect(r.statusCode).toBe(200);
      } else {
        expect(g.modules[1]).toMatchObject({ icon: '🔥', apiItems: [{ name: 'x' }] });
      }
      await a.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('module position', () => {
  const dbFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pjp-')), 'p.db');

  it('round trips, validates, 404s and survives module PUT', async () => {
    const m = await mod('P');
    expect(m).toMatchObject({ x: null, y: null });
    const r = await call('PUT', `/api/modules/${m.id}/position`, { x: 10.5, y: -3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: m.id, x: 10.5, y: -3 });
    expect((await call('GET', `/api/modules/${m.id}`)).body).toMatchObject({ x: 10.5, y: -3 });
    expect((await call('GET', '/api/graph')).body.modules[0]).toMatchObject({ x: 10.5, y: -3 });
    const put = await call('PUT', `/api/modules/${m.id}`, { name: 'Q', x: 1, y: 2 });
    expect(put.body).toMatchObject({ name: 'Q', x: 10.5, y: -3 });
    for (const bad of [{}, { x: 1 }, { x: '1', y: 2 }, { x: null, y: 2 }, { x: 1e6 + 1, y: 0 }, { x: 0, y: -1e7 }]) {
      expect((await call('PUT', `/api/modules/${m.id}/position`, bad)).status).toBe(400);
    }
    expect((await call('PUT', '/api/modules/999/position', { x: 1, y: 1 })).status).toBe(404);
  });

  it('persists across reopen and migrates old schema twice', async () => {
    const f = dbFile();
    const old = new Database(f);
    old.exec(`CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT);
      INSERT INTO modules (name) VALUES ('legacy');`);
    old.close();
    let a = buildApp(f);
    let r = await a.inject({ method: 'GET', url: '/api/modules' });
    expect(JSON.parse(r.body)[0]).toMatchObject({ name: 'legacy', x: null, y: null });
    await a.inject({ method: 'PUT', url: '/api/modules/1/position', payload: { x: 5, y: 6 } });
    await a.close();
    a = buildApp(f);
    r = await a.inject({ method: 'GET', url: '/api/modules/1' });
    expect(JSON.parse(r.body)).toMatchObject({ x: 5, y: 6 });
    await a.close();
  });
});

describe('module stroke and text styles', () => {
  it('defaults, create, PUT omit keeps, null clears, normalises case', async () => {
    const d = await mod('D');
    expect(d).toMatchObject({ textColor: null, strokeColor: null, strokeStyle: 'solid' });
    const m = await mod('S', { textColor: '#AABBCC', strokeColor: '#001122', strokeStyle: 'dashed' });
    expect(m).toMatchObject({ textColor: '#aabbcc', strokeColor: '#001122', strokeStyle: 'dashed' });
    const kept = await call('PUT', `/api/modules/${m.id}`, { name: 'S2' });
    expect(kept.body).toMatchObject({ textColor: '#aabbcc', strokeColor: '#001122', strokeStyle: 'dashed' });
    const cleared = await call('PUT', `/api/modules/${m.id}`, { name: 'S2', textColor: null, strokeColor: null, strokeStyle: 'dotted' });
    expect(cleared.body).toMatchObject({ textColor: null, strokeColor: null, strokeStyle: 'dotted' });
    const g = (await call('GET', '/api/graph')).body.modules;
    expect(g[1]).toMatchObject({ strokeStyle: 'dotted' });
  });

  it('rejects invalid values', async () => {
    const m = await mod('S');
    for (const bad of [{ textColor: 'red' }, { strokeColor: '#12345' }, { textColor: 5 }, { strokeStyle: null }, { strokeStyle: 'wavy' }, { strokeStyle: 1 }]) {
      for (const [method, url] of [['POST', '/api/modules'], ['PUT', `/api/modules/${m.id}`]]) {
        const r = await call(method, url, { name: 'x', ...bad });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('validation_error');
      }
    }
  });

  it('migrates a pre-style database twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-style-'));
    const file = path.join(dir, 'old.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', color TEXT NULL, icon TEXT NULL, x REAL NULL, y REAL NULL);
      INSERT INTO modules (name, color, x, y) VALUES ('A', '#112233', 1, 2);
    `);
    raw.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const r = (await a.inject({ method: 'GET', url: '/api/modules/1' })).json();
      expect(r).toMatchObject({ color: '#112233', x: 1, y: 2, textColor: null, strokeColor: null, strokeStyle: 'solid' });
      await a.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('relation colour: create, partial PUT, null clears, validation, graph', async () => {
    const a = await mod('A'); const b = await mod('B');
    const r = await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id, label: 'x', color: '#FF00AA' });
    expect(r.body).toMatchObject({ label: 'x', color: '#ff00aa' });
    const url = `/api/relations/${r.body.id}`;
    expect((await call('PUT', url, { color: '#00ff00' })).body).toMatchObject({ label: 'x', color: '#00ff00' });
    expect((await call('PUT', url, { label: 'y' })).body).toMatchObject({ label: 'y', color: '#00ff00' });
    expect((await call('GET', '/api/graph')).body.relations[0]).toMatchObject({ label: 'y', color: '#00ff00' });
    expect((await call('PUT', url, { color: 'red' })).status).toBe(400);
    expect((await call('PUT', url, {})).status).toBe(400);
    expect((await call('PUT', url, { color: null })).body).toMatchObject({ label: 'y', color: null });
    expect((await call('PUT', url, { label: null })).body).toMatchObject({ label: null });
    const r2 = await call('POST', '/api/relations', { sourceId: b.id, targetId: a.id });
    expect(r2.body.color).toBeNull();
    expect((await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id, color: 'x' })).status).toBe(400);
  });

  it('adds relations.color to an old database, twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'old.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
      CREATE TABLE relations (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE, label TEXT, UNIQUE (source_id, target_id), CHECK (source_id <> target_id));
      INSERT INTO modules (name) VALUES ('A'), ('B');
      INSERT INTO relations (source_id, target_id, label) VALUES (1, 2, 'uses');
    `);
    raw.close();
    for (let round = 0; round < 2; round++) {
      const a = buildApp(file);
      const g = (await a.inject({ method: 'GET', url: '/api/graph' })).json();
      expect(g.relations).toEqual([{ id: 1, sourceId: 1, targetId: 2, label: 'uses', color: round ? '#123456' : null }]);
      if (!round) await a.inject({ method: 'PUT', url: '/api/relations/1', payload: { color: '#123456' } });
      await a.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('groups', () => {
  const group = async (name: string, extra: any = {}) => (await call('POST', '/api/groups', { name, ...extra })).body;

  it('CRUD, validation, 404', async () => {
    const r = await call('POST', '/api/groups', { name: ' G ', color: '#AABBCC', icon: '📦' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'G', color: '#aabbcc', icon: '📦' });
    const gid = r.body.id;
    expect((await call('GET', '/api/groups')).body).toHaveLength(1);
    const p = await call('PUT', `/api/groups/${gid}`, { name: 'G' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ color: '#aabbcc', icon: '📦' });
    expect((await call('PUT', `/api/groups/${gid}`, { name: 'G', color: null, icon: null })).body).toMatchObject({ color: null, icon: null });
    expect((await call('POST', '/api/groups', { name: '' })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'a', color: 'red' })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'a', icon: 'toolongicon' })).status).toBe(400);
    expect((await call('PUT', '/api/groups/999', { name: 'a' })).status).toBe(404);
    expect((await call('DELETE', '/api/groups/999')).status).toBe(404);
    expect((await call('DELETE', `/api/groups/${gid}`)).status).toBe(204);
  });

  it('name conflicts are case-insensitive and rename ignores self', async () => {
    const a = await group('Alpha');
    const b = await group('Beta');
    expect((await call('POST', '/api/groups', { name: 'ALPHA' })).status).toBe(409);
    expect((await call('PUT', `/api/groups/${b.id}`, { name: 'alpha' })).status).toBe(409);
    expect((await call('PUT', `/api/groups/${a.id}`, { name: 'ALPHA' })).status).toBe(200);
  });

  it('module groupId: omit unchanged, null clears, unknown 400', async () => {
    const g = await group('G');
    const m = await mod('M');
    expect(m.groupId).toBeNull();
    const m2 = await mod('M2', { groupId: g.id });
    expect(m2.groupId).toBe(g.id);
    expect((await call('PUT', `/api/modules/${m2.id}`, { name: 'M2b' })).body.groupId).toBe(g.id);
    expect((await call('PUT', `/api/modules/${m.id}`, { name: 'M', groupId: g.id })).body.groupId).toBe(g.id);
    expect((await call('PUT', `/api/modules/${m.id}`, { name: 'M', groupId: null })).body.groupId).toBeNull();
    expect((await call('PUT', `/api/modules/${m.id}`, { name: 'M', groupId: 999 })).status).toBe(400);
    expect((await call('POST', '/api/modules', { name: 'X', groupId: 999 })).status).toBe(400);
    expect((await call('POST', '/api/modules', { name: 'X', groupId: 'a' })).status).toBe(400);
    const graph = (await call('GET', '/api/graph')).body;
    expect(graph.groups).toEqual([g]);
    expect(graph.modules.find((x: any) => x.id === m2.id).groupId).toBe(g.id);
  });

  it('deleting a group ungroups but keeps modules', async () => {
    const g = await group('G');
    const m = await mod('M', { groupId: g.id });
    await call('DELETE', `/api/groups/${g.id}`);
    expect((await call('GET', `/api/modules/${m.id}`)).body).toMatchObject({ name: 'M', groupId: null });
  });

  it('group parentId: create, omit unchanged, null clears, validation', async () => {
    const a = await group('A');
    const b = await group('B', { parentId: a.id });
    expect(a.parentId).toBeNull();
    expect(b.parentId).toBe(a.id);
    expect((await call('PUT', `/api/groups/${b.id}`, { name: 'B2' })).body.parentId).toBe(a.id);
    expect((await call('GET', '/api/graph')).body.groups.find((g: any) => g.id === b.id).parentId).toBe(a.id);
    expect((await call('PUT', `/api/groups/${b.id}`, { name: 'B2', parentId: null })).body.parentId).toBeNull();
    expect((await call('PUT', `/api/groups/${b.id}`, { name: 'B2', parentId: a.id })).body.parentId).toBe(a.id);
    for (const parentId of [999, 'x', 1.5, b.id]) {
      const e = await call('PUT', `/api/groups/${b.id}`, { name: 'B2', parentId });
      expect(e.status).toBe(400);
      expect(e.body.error.code).toBe('validation_error');
    }
    expect((await call('POST', '/api/groups', { name: 'X', parentId: 999 })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'X', parentId: '1' })).status).toBe(400);
  });

  it('group parentId rejects cycles and depth over 4', async () => {
    const a = await group('A');
    const b = await group('B', { parentId: a.id });
    const c = await group('C', { parentId: b.id });
    const d = await group('D', { parentId: c.id });
    expect((await call('PUT', `/api/groups/${a.id}`, { name: 'A', parentId: c.id })).status).toBe(400);
    expect((await call('POST', '/api/groups', { name: 'E', parentId: d.id })).status).toBe(400);
    const e = await group('E');
    expect((await call('PUT', `/api/groups/${e.id}`, { name: 'E', parentId: d.id })).status).toBe(400);
    const f = await group('F');
    const g = await group('G', { parentId: f.id });
    expect((await call('PUT', `/api/groups/${f.id}`, { name: 'F', parentId: c.id })).status).toBe(400);
    expect((await call('PUT', `/api/groups/${f.id}`, { name: 'F', parentId: b.id })).status).toBe(200);
    expect((await call('PUT', `/api/groups/${g.id}`, { name: 'G', parentId: null })).status).toBe(200);
  });

  it('deleting a mid-tree group reparents children; top-level delete nulls them', async () => {
    const a = await group('A');
    const b = await group('B', { parentId: a.id });
    const c = await group('C', { parentId: b.id });
    const m = await mod('M', { groupId: b.id });
    expect((await call('DELETE', `/api/groups/${b.id}`)).status).toBe(204);
    expect((await call('GET', '/api/groups')).body.find((g: any) => g.id === c.id).parentId).toBe(a.id);
    expect((await call('GET', `/api/modules/${m.id}`)).body).toMatchObject({ groupId: null });
    expect((await call('DELETE', `/api/groups/${a.id}`)).status).toBe(204);
    expect((await call('GET', '/api/groups')).body).toEqual([{ ...c, parentId: null }]);
  });

  it('batch module positions: success, atomic failure, validation', async () => {
    const m1 = await mod('A');
    const m2 = await mod('B');
    const ok = await call('PUT', '/api/modules/positions', { positions: [{ id: m1.id, x: 1, y: 2 }, { id: m2.id, x: -3.5, y: 4 }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(2);
    expect(ok.body[1]).toMatchObject({ id: m2.id, x: -3.5, y: 4 });
    const bad = await call('PUT', '/api/modules/positions', { positions: [{ id: m1.id, x: 9, y: 9 }, { id: 999, x: 1, y: 1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    expect((await call('GET', `/api/modules/${m1.id}`)).body).toMatchObject({ x: 1, y: 2 });
    const p = (id: number) => ({ id, x: 0, y: 0 });
    expect((await call('PUT', '/api/modules/positions', { positions: Array.from({ length: 500 }, () => p(m1.id)) })).status).toBe(400);
    for (const positions of [[], 'x', undefined, [{ id: m1.id, x: 'a', y: 0 }], [{ id: m1.id, x: 1e7, y: 0 }], [{ id: m1.id, x: 0 }], [p(m1.id), p(m1.id)], [{ id: 'a', x: 0, y: 0 }]]) {
      expect((await call('PUT', '/api/modules/positions', { positions })).status).toBe(400);
    }
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    expect((await call('PUT', '/api/modules/positions', { positions: ids.map(p) })).status).toBe(400);
    expect((await call('PUT', `/api/modules/${m1.id}/position`, { x: 5, y: 6 })).body).toMatchObject({ x: 5, y: 6 });
  });

  it('ON DELETE SET NULL works on the table with foreign_keys on; old DB migrates twice', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-')), 'old.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
      CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
      INSERT INTO modules (name) VALUES ('Old');
      INSERT INTO owners (name, email) VALUES ('Ann', 'a@x.com');
    `);
    old.exec(`
      CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT);
      INSERT INTO groups (name) VALUES ('Legacy');
    `);
    old.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const g = (await a.inject({ method: 'POST', url: '/api/groups', payload: { name: `G${i}` } })).json();
      const m = (await a.inject({ method: 'GET', url: '/api/modules/1' })).json();
      expect(m).toMatchObject({ name: 'Old', groupId: null });
      expect(g.id).toBeGreaterThan(0);
      expect(g.parentId).toBeNull();
      const child = (await a.inject({ method: 'POST', url: '/api/groups', payload: { name: `C${i}`, parentId: 1 } })).json();
      expect(child.parentId).toBe(1);
      await a.close();
    }
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.prepare('UPDATE modules SET group_id = 1 WHERE id = 1').run();
    db.prepare('DELETE FROM groups WHERE id = 1').run();
    expect((db.prepare('SELECT group_id FROM modules WHERE id = 1').get() as any).group_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM modules').get()).toEqual({ c: 1 });
    db.close();
  });
});

describe('issues', () => {
  const issue = async (type: string, title: string, extra: any = {}) => call('POST', '/api/issues', { type, title, ...extra });
  const mk = async (type: string, title: string, extra: any = {}) => (await issue(type, title, extra)).body;

  it('CRUD with defaults and payload shape', async () => {
    const o = await owner('O');
    const m = await mod('M', { ownerIds: [o.id] });
    expect((await issue('epic', 'E', { ownerId: o.id })).status).toBe(400);
    const stranger = await owner('X');
    expect((await issue('task', 'x', { ownerId: o.id })).status).toBe(400); // module first
    expect((await issue('task', 'x', { ownerId: stranger.id, moduleId: m.id })).status).toBe(400); // must own the module
    expect((await issue('bug', 'B', { moduleId: m.id })).status).toBe(400);
    const r = await issue('task', '  E  ', { ownerId: o.id, moduleId: m.id });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 1, type: 'task', title: 'E', description: '', implementation: '', parentId: null, ownerId: o.id, moduleId: m.id, sprintId: null, estimate: null, state: 'open', jiraKey: null, childIds: [], rollupModuleIds: [m.id], createdAt: expect.stringMatching(/Z$/), startedAt: null, closedAt: null, closedOwnerId: null, reopenCount: 0, updatedAt: expect.stringMatching(/Z$/) });
    const put = await call('PUT', '/api/issues/1', { type: 'task', title: 'E2', state: 'closed' });
    expect(put.body).toMatchObject({ title: 'E2', state: 'closed', ownerId: null, moduleId: m.id });
    expect((await call('PUT', '/api/issues/1', { type: 'task', title: 'E2', moduleId: null })).status).toBe(400); // a module cannot be taken away
    expect((await call('GET', '/api/issues')).body).toHaveLength(1);
    expect((await call('GET', '/api/issues/1')).status).toBe(200);
    expect((await call('DELETE', '/api/issues/1')).status).toBe(204);
    expect((await call('GET', '/api/issues/1')).status).toBe(404);
    expect((await call('PUT', '/api/issues/1', { type: 'task', title: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/issues/1')).status).toBe(404);
  });

  it('validates fields', async () => {
    expect((await issue('epic', '  ')).status).toBe(400);
    expect((await issue('nope', 'x')).status).toBe(400);
    expect((await issue('task', 'x', { state: 'bad' })).status).toBe(400);
    expect((await issue('task', 'x', { moduleId: [1] })).status).toBe(400);
    expect((await issue('task', 'x', { moduleId: 1.5 })).status).toBe(400);
    expect((await issue('task', 'x', { moduleId: 99 })).status).toBe(404);
    expect((await issue('task', 'x', { ownerId: 99 })).status).toBe(404);
    expect((await issue('task', 'x', { parentId: 99 })).status).toBe(404);
    // every task needs a module, whether the key is missing or null
    const bare = await app.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: 'x' } });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.message).toBe('a task needs a module (moduleId)');
    expect((await call('POST', '/api/issues', { type: 'task', title: 'x', moduleId: null })).status).toBe(400);
  });

  it('enforces hierarchy rules on create', async () => {
    const e = await mk('epic', 'E');
    const b = await mk('bug', 'B', { parentId: e.id });
    const t = await issue('task', 'T', { parentId: b.id });
    expect(t.status).toBe(201);
    expect((await issue('epic', 'E2', { parentId: e.id })).status).toBe(400);
    expect((await issue('bug', 'B2', { parentId: b.id })).status).toBe(400);
    expect((await issue('task', 'x', { parentId: t.body.id })).status).toBe(400);
    expect((await issue('subtask', 's', { parentId: b.id })).status).toBe(400);
    expect((await call('GET', `/api/issues/${b.id}`)).body.childIds).toEqual([t.body.id]);
  });

  it('estimate: tasks only, 1-99, kept when omitted, survives export/import', async () => {
    const t = await issue('task', 'T', { estimate: 3 });
    expect(t.body.estimate).toBe(3);
    expect((await issue('task', 'U')).body.estimate).toBeNull();
    expect((await issue('task', 'bad', { estimate: 0 })).status).toBe(400);
    expect((await issue('task', 'bad', { estimate: 1.5 })).status).toBe(400);
    expect((await issue('bug', 'B', { estimate: 2 })).status).toBe(400);
    const kept = await call('PUT', `/api/issues/${t.body.id}`, { type: 'task', title: 'T2' });
    expect(kept.body.estimate).toBe(3);
    expect((await call('PUT', `/api/issues/${t.body.id}`, { type: 'task', title: 'T2', estimate: null })).body.estimate).toBeNull();
    await call('PUT', `/api/issues/${t.body.id}`, { type: 'task', title: 'T2', estimate: 5 });
    const file = (await app.inject({ method: 'GET', url: '/api/projects/1/export' })).body;
    const imp = await app.inject({ method: 'POST', url: '/api/projects/import', payload: JSON.parse(file) });
    const copy = (await app.inject({ method: 'GET', url: '/api/issues', headers: { 'x-project': String(JSON.parse(imp.body).id) } })).body;
    expect(JSON.parse(copy).find((i: any) => i.title === 'T2').estimate).toBe(5);
  });

  it('story: under an epic, holds tasks, no module/assignee/sprint of its own', async () => {
    const e = await mk('epic', 'E');
    const st = await issue('story', 'S', { parentId: e.id });
    expect(st.status).toBe(201);
    expect(st.body.type).toBe('story');
    expect((await issue('story', 'top')).status).toBe(201); // a story may also stand alone
    expect((await issue('task', 'T', { parentId: st.body.id })).status).toBe(201);
    expect((await issue('story', 'S2', { parentId: st.body.id })).status).toBe(400); // not under a story
    const b = await mk('bug', 'B', { parentId: e.id });
    expect((await issue('story', 'S3', { parentId: b.id })).status).toBe(400); // not under a bug
    expect((await issue('epic', 'E2', { parentId: st.body.id })).status).toBe(400);
    const o = await owner('O'); const m = await mod('M', { ownerIds: [o.id] });
    expect((await issue('story', 'x', { moduleId: m.id })).body.error.message).toBe('a story cannot have an assignee or a module; set them on its tasks');
    const sp = (await call('POST', '/api/sprints', { name: 'S' })).body;
    expect((await issue('story', 'x', { sprintId: sp.id })).status).toBe(400);
    expect((await issue('bug', 'x', { parentId: st.body.id })).body.error.message).toBe('a bug parent must be an epic');
    expect((await issue('task', 'x', { parentId: 99 })).status).toBe(404);
    // roll-up through a story: the epic sees the modules of tasks under its story
    const t = await issue('task', 'T2', { parentId: st.body.id, moduleId: m.id });
    expect(t.status).toBe(201);
    expect((await call('GET', `/api/issues/${e.id}`)).body.rollupModuleIds).toContain(m.id);
    // a story that holds tasks cannot become a task (tasks hold nothing)
    expect((await call('PUT', `/api/issues/${st.body.id}`, { type: 'task', title: 'S', parentId: e.id })).status).toBe(400);
  });

  it('enforces rules when changing type or parent via PUT', async () => {
    const e = await mk('epic', 'E');
    const b = await mk('bug', 'B', { parentId: e.id });
    const t = await mk('task', 'T', { parentId: b.id });
    const put = (i: any, x: any) => call('PUT', `/api/issues/${i.id}`, { title: i.title, ...x });
    expect((await put(b, { type: 'epic', parentId: e.id })).status).toBe(400); // an epic has no parent
    expect((await put(t, { type: 'bug', parentId: b.id })).status).toBe(400); // bug only under an epic
    expect((await put(e, { type: 'task' })).status).toBe(400); // child bug not allowed under a task
    expect((await put(b, { type: 'task' })).status).toBe(400); // child task not allowed under a task
    expect((await put(t, { type: 'task', parentId: e.id })).status).toBe(200);
  });

  it('rejects cycles', async () => {
    const e = await mk('epic', 'E');
    expect((await call('PUT', `/api/issues/${e.id}`, { type: 'epic', title: 'E', parentId: e.id })).status).toBe(400);
  });

  it('rolls up descendant modules sorted and deduped', async () => {
    const m1 = await mod('A'); const m2 = await mod('B'); const m3 = await mod('C');
    const e = await mk('epic', 'E');
    const t1 = await mk('task', 't1', { parentId: e.id, moduleId: m2.id });
    await mk('task', 't2', { parentId: e.id, moduleId: m2.id });
    const bg = await mk('bug', 'g', { parentId: e.id });
    await mk('task', 't3', { parentId: bg.id, moduleId: m1.id });
    await mk('task', 't4', { parentId: e.id, moduleId: m3.id });
    expect((await call('GET', `/api/issues/${e.id}`)).body.rollupModuleIds).toEqual([m1.id, m2.id, m3.id]);
    expect((await call('GET', `/api/issues/${bg.id}`)).body.rollupModuleIds).toEqual([m1.id]);
  });

  it('orphans children on delete', async () => {
    const e = await mk('epic', 'E');
    const b = await mk('bug', 'B', { parentId: e.id });
    const t = await mk('task', 'T', { parentId: b.id });
    await call('DELETE', `/api/issues/${b.id}`);
    expect((await call('GET', `/api/issues/${t.id}`)).body).toMatchObject({ type: 'task', parentId: null });
    expect((await call('GET', `/api/issues/${e.id}`)).body.childIds).toEqual([]);
    expect((await call('PUT', `/api/issues/${t.id}`, { type: 'task', title: 'renamed' })).status).toBe(200);
  });

  it('migrates subtask to task, keeps stories, and lifts tasks out from under tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'old.db');
    const first = buildApp(file); await first.close();
    const raw = new Database(file);
    raw.exec(`INSERT INTO issues (type, title, parent_id) VALUES ('epic','E',NULL),('story','S',1),('subtask','s',2),('subtask','ss',3);`);
    raw.close();
    const a = buildApp(file);
    const list = (await a.inject({ method: 'GET', url: '/api/issues' })).json();
    expect(list.map((x: any) => [x.id, x.type, x.parentId])).toEqual([[1, 'epic', null], [2, 'story', 1], [3, 'task', 2], [4, 'task', 2]]);
    await a.close();
  });

  it('module delete nulls moduleId, owner delete nulls assignee', async () => {
    const o = await owner('O'); const m = await mod('M', { ownerIds: [o.id] });
    const t = await mk('task', 'T', { moduleId: m.id, ownerId: o.id });
    await call('DELETE', `/api/modules/${m.id}`);
    await call('DELETE', `/api/owners/${o.id}`);
    expect((await call('GET', `/api/issues/${t.id}`)).body).toMatchObject({ moduleId: null, ownerId: null, rollupModuleIds: [] });
  });

  it('migrates idempotently, adding issues to an existing DB', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pjp-')), 'p.db');
    const old = new Database(file);
    old.exec("CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '')");
    old.prepare("INSERT INTO modules (name) VALUES ('Old')").run();
    old.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const r = await a.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: `T${i}`, moduleId: 1 } });
      expect(r.statusCode).toBe(201);
      expect((await a.inject({ method: 'GET', url: '/api/issues' })).json()).toHaveLength(i + 1);
      await a.close();
    }
    // issues table that predates module_id gets the column
    const db = new Database(file);
    db.exec('DROP TABLE issues; CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\', parent_id INTEGER, owner_id INTEGER, state TEXT NOT NULL DEFAULT \'todo\', created_at TEXT)');
    db.close();
    const a = buildApp(file);
    expect((await a.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: 'x', moduleId: 1 } })).statusCode).toBe(201);
    await a.close();
  });

  it('rejects old issue states', async () => {
    for (const state of ['todo', 'doing', 'done']) {
      expect((await call('POST', '/api/issues', { type: 'task', title: 'x', state })).status).toBe(400);
    }
  });

  it('migrates todo/doing/done issues to open/closed, keeping links, idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'old.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '');
      CREATE TABLE owners (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, icon TEXT);
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('epic','story','task','bug','subtask')),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        parent_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
        owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
        module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'todo' CHECK (state IN ('todo','doing','done')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO modules (name) VALUES ('M');
      INSERT INTO owners (name) VALUES ('O');
      INSERT INTO issues (type, title, parent_id, owner_id, module_id, state) VALUES
        ('epic', 'E', NULL, 1, 1, 'doing'), ('story', 'S', 1, NULL, 1, 'todo'), ('task', 'T', 1, 1, NULL, 'done');
    `);
    raw.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const list = (await a.inject({ method: 'GET', url: '/api/issues' })).json();
      expect(list.map((x: any) => [x.id, x.state, x.parentId, x.ownerId, x.moduleId])).toEqual([
        [1, 'open', null, null, null], [2, 'open', 1, null, null], [3, 'closed', 1, 1, null], // a story carries no module
      ]);
      expect((await a.inject({ method: 'POST', url: '/api/issues', payload: { type: 'bug', title: 'n' } })).json().state).toBe('open');
      await a.close();
      const chk = new Database(file);
      chk.prepare('DELETE FROM issues WHERE id = 4').run();
      chk.close();
    }
  });
});

describe('projects', () => {
  const inP = async (pid: number, method: any, url: string, payload?: any) => {
    const r = await app.inject({ method, url, payload, headers: { 'x-project': String(pid) } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  it('a fresh database has no project; data routes ask for one first', async () => {
    const fresh = buildApp(':memory:');
    expect((await fresh.inject({ method: 'GET', url: '/api/projects' })).json()).toEqual([]);
    const r = await fresh.inject({ method: 'GET', url: '/api/graph' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('no_project');
    expect((await fresh.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const p = (await fresh.inject({ method: 'POST', url: '/api/projects', payload: { name: 'First' } })).json();
    expect((await fresh.inject({ method: 'GET', url: '/api/graph' })).statusCode).toBe(200);
    // deleting every project goes back to the empty state
    expect((await fresh.inject({ method: 'DELETE', url: `/api/projects/${p.id}` })).statusCode).toBe(204);
    expect((await fresh.inject({ method: 'GET', url: '/api/graph' })).json().error.code).toBe('no_project');
    await fresh.close();
  });

  it('counts belong to the project', async () => {
    await mod('A');
    expect((await call('GET', '/api/projects')).body[0]).toMatchObject({ name: 'Test', moduleCount: 1 });
  });

  it('CRUD and unique names', async () => {
    const p = (await call('POST', '/api/projects', { name: 'Two' })).body;
    expect((await call('POST', '/api/projects', { name: 'two' })).status).toBe(409);
    expect((await call('PUT', `/api/projects/${p.id}`, { name: 'Renamed', description: 'd' })).body).toMatchObject({ name: 'Renamed', description: 'd' });
    expect((await call('DELETE', `/api/projects/${p.id}`)).status).toBe(204);
    expect((await call('GET', `/api/projects/${p.id}`)).status).toBe(404);
    expect((await call('DELETE', '/api/projects/1')).status).toBe(204); // any project can go, even the first
  });

  it('isolates data per project and defaults to the first', async () => {
    const p2 = (await call('POST', '/api/projects', { name: 'Two' })).body.id;
    await mod('InDefault');
    expect((await inP(p2, 'GET', '/api/modules')).body).toEqual([]);
    const m = (await inP(p2, 'POST', '/api/modules', { name: 'InTwo' })).body;
    expect((await call('GET', '/api/modules')).body.map((x: any) => x.name)).toEqual(['InDefault']);
    // cross-project references are rejected / invisible
    expect((await call('GET', `/api/modules/${m.id}`)).status).toBe(404);
    expect((await call('POST', '/api/owners', { name: 'Same' })).status).toBe(201);
    expect((await inP(p2, 'POST', '/api/owners', { name: 'Same' })).status).toBe(201);
    const o1 = (await call('GET', '/api/owners')).body[0].id;
    expect((await inP(p2, 'POST', '/api/modules', { name: 'X', ownerIds: [o1] })).status).toBe(400);
    expect((await inP(p2, 'POST', '/api/issues', { type: 'task', title: 't', moduleId: 1 })).status).toBe(404);
    expect((await call('GET', '/api/modules', undefined)).status).toBe(200);
    expect((await inP(999, 'GET', '/api/modules')).status).toBe(404);
  });

  it('deleting a project removes only its data', async () => {
    const p2 = (await call('POST', '/api/projects', { name: 'Two' })).body.id;
    await mod('Keep');
    const a = (await inP(p2, 'POST', '/api/modules', { name: 'A' })).body;
    const b = (await inP(p2, 'POST', '/api/modules', { name: 'B' })).body;
    await inP(p2, 'POST', '/api/relations', { sourceId: a.id, targetId: b.id });
    const e = (await inP(p2, 'POST', '/api/issues', { type: 'epic', title: 'E' })).body;
    await inP(p2, 'POST', '/api/issues', { type: 'task', title: 'T', parentId: e.id, moduleId: a.id });
    await inP(p2, 'POST', '/api/sprints', { name: 'S' });
    expect((await call('DELETE', `/api/projects/${p2}`)).status).toBe(204);
    expect((await call('GET', '/api/modules')).body.map((x: any) => x.name)).toEqual(['Keep']);
  });

  it('exports and imports a project as a new, remapped project', async () => {
    const o = (await call('POST', '/api/owners', { name: 'Ann', color: '#112233' })).body;
    const g = (await call('POST', '/api/groups', { name: 'Core' })).body;
    const g2 = (await call('POST', '/api/groups', { name: 'Sub', parentId: g.id })).body;
    const a = await mod('A', { ownerIds: [o.id], groupId: g2.id, color: '#ff0000', apiItems: [{ kind: 'function', name: 'f', signature: 'f()', description: '' }] });
    const b = await mod('B');
    await call('PUT', `/api/modules/${a.id}/position`, { x: 10, y: 20 });
    await call('POST', '/api/relations', { sourceId: a.id, targetId: b.id, label: 'uses', color: '#00ff00' });
    const sp = (await call('POST', '/api/sprints', { name: 'S1', goal: 'g' })).body;
    const e = (await call('POST', '/api/issues', { type: 'epic', title: 'E' })).body;
    await call('POST', '/api/issues', { type: 'task', title: 'T', parentId: e.id, moduleId: a.id, ownerId: o.id, sprintId: sp.id });

    const res = await app.inject({ method: 'GET', url: '/api/projects/1/export' });
    expect(res.headers['content-disposition']).toContain('.pjplanner.json');
    const file = JSON.parse(res.body);
    expect(file.format).toBe('pjplanner-project');

    // import into a fresh app (other pjPlanner), and into the same one
    for (const target of [buildApp(':memory:'), app]) {
      const imp = await target.inject({ method: 'POST', url: '/api/projects/import', payload: file });
      expect(imp.statusCode).toBe(201);
      const np = imp.json();
      expect(np.name).toBe(target === app ? 'Test (2)' : 'Test'); // the fresh instance has no project, so no clash
      const h = { 'x-project': String(np.id) };
      const get = async (u: string) => (await target.inject({ method: 'GET', url: u, headers: h })).json();
      const mods = await get('/api/modules');
      expect(mods.map((m: any) => m.name)).toEqual(['A', 'B']);
      const A = mods[0];
      expect(A).toMatchObject({ color: '#ff0000', x: 10, y: 20 });
      expect(A.apiItems).toHaveLength(1);
      const owners = await get('/api/owners');
      expect(A.ownerIds).toEqual([owners[0].id]);
      const groups = await get('/api/groups');
      expect(groups.find((x: any) => x.name === 'Sub').parentId).toBe(groups.find((x: any) => x.name === 'Core').id);
      expect(A.groupId).toBe(groups.find((x: any) => x.name === 'Sub').id);
      const rels = await get('/api/relations');
      expect(rels).toMatchObject([{ sourceId: mods[0].id, targetId: mods[1].id, label: 'uses', color: '#00ff00' }]);
      const issues = await get('/api/issues');
      const task = issues.find((i: any) => i.type === 'task');
      expect(task).toMatchObject({ parentId: issues.find((i: any) => i.type === 'epic').id, moduleId: A.id, ownerId: owners[0].id });
      expect(task.sprintId).toBe((await get('/api/sprints'))[0].id);
    }
    // original untouched
    expect((await call('GET', '/api/modules')).body).toHaveLength(2);
  });

  it('rejects bad import files without creating a project', async () => {
    const bads = [
      {}, { format: 'pjplanner-project', version: 2, project: { name: 'x' } },
      { format: 'pjplanner-project', version: 1, project: { name: 'x' }, modules: [{ id: 1, name: 'M', groupId: 9 }] },
      { format: 'pjplanner-project', version: 1, project: { name: 'x' }, relations: [{ id: 1, sourceId: 1, targetId: 2 }] },
      { format: 'pjplanner-project', version: 1, project: { name: 'x' }, issues: [{ id: 1, type: 'task', title: 't', parentId: 1 }] },
      { format: 'pjplanner-project', version: 1, project: { name: 'x' }, sprints: [{ id: 1, name: 'a', state: 'active' }, { id: 2, name: 'b', state: 'active' }] },
    ];
    bads.push({ format: 'pjplanner-project', version: 1, project: { name: 'x' }, modules: [{ id: 1, name: 'M', ownerIds: [null] }] });
    for (const payload of bads) expect((await call('POST', '/api/projects/import', payload)).status).toBe(400);
    expect((await call('GET', '/api/projects')).body).toHaveLength(1);
  });

  it('answers /api/access and /api/unlock before any project exists', async () => {
    const fresh = buildApp(':memory:');
    expect((await fresh.inject({ method: 'GET', url: '/api/access' })).statusCode).toBe(200);
    expect((await fresh.inject({ method: 'POST', url: '/api/unlock', payload: {} })).statusCode).toBe(200);
    expect((await fresh.inject({ method: 'GET', url: '/api/graph' })).statusCode).toBe(404);
  });

  it('moves data from before projects into one project called "My project"', async () => {
    const f = path.join(os.tmpdir(), `proj-${process.pid}-${Date.now()}.db`);
    const a0 = buildApp(f);
    await a0.inject({ method: 'POST', url: '/api/projects', payload: { name: 'tmp' } });
    await a0.inject({ method: 'POST', url: '/api/modules', payload: { name: 'Old' } });
    await a0.close();
    const raw = new Database(f);
    raw.exec('UPDATE modules SET project_id = NULL; DELETE FROM projects; DROP TABLE projects;');
    raw.close();
    for (let i = 0; i < 2; i++) { // idempotent
      const a = buildApp(f);
      expect((await a.inject({ method: 'GET', url: '/api/modules' })).json().map((m: any) => m.name)).toEqual(['Old']);
      expect((await a.inject({ method: 'GET', url: '/api/projects' })).json().map((p: any) => p.name)).toEqual(['My project']);
      await a.close();
    }
    fs.rmSync(f);
  });
});

describe('issue workflow states', () => {
  const task = async (title: string, extra: any = {}) => (await call('POST', '/api/issues', { type: 'task', title, ...extra })).body;

  it('accepts open, code_review, test_validation and closed, nothing else', async () => {
    for (const state of ['open', 'code_review', 'test_validation', 'closed']) {
      expect((await task(`t-${state}`, { state })).state).toBe(state);
    }
    const r = await call('POST', '/api/issues', { type: 'task', title: 'x', state: 'doing' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('code_review');
  });

  it('counts review and validation as unfinished in a sprint, and closing the sprint returns them to the backlog', async () => {
    const s = (await call('POST', '/api/sprints', { name: 'S' })).body;
    const a = await task('a', { sprintId: s.id, state: 'code_review' });
    const b = await task('b', { sprintId: s.id, state: 'test_validation' });
    const c = await task('c', { sprintId: s.id, state: 'closed' });
    const got = (await call('GET', `/api/sprints/${s.id}`)).body;
    expect(got).toMatchObject({ openCount: 2, closedCount: 1 });
    await call('PUT', `/api/sprints/${s.id}`, { name: 'S', state: 'active' });
    await call('PUT', `/api/sprints/${s.id}`, { name: 'S', state: 'closed' });
    expect((await call('GET', `/api/issues/${a.id}`)).body).toMatchObject({ sprintId: null, state: 'code_review' });
    expect((await call('GET', `/api/issues/${b.id}`)).body).toMatchObject({ sprintId: null, state: 'test_validation' });
    expect((await call('GET', `/api/issues/${c.id}`)).body.sprintId).toBe(s.id); // done work stays as the sprint's history
  });

  it('a re-deal keeps the owner of a task already in review', async () => {
    const o = await owner('Ann');
    const m = await mod('M', { ownerIds: [o.id] });
    const s = (await call('POST', '/api/sprints', { name: 'S' })).body;
    const inReview = await task('r', { sprintId: s.id, moduleId: m.id, ownerId: o.id, state: 'code_review' });
    const plain = await task('p', { sprintId: s.id, moduleId: m.id, ownerId: o.id });
    await call('POST', `/api/sprints/${s.id}/assign?reset=1`);
    expect((await call('GET', `/api/issues/${inReview.id}`)).body.ownerId).toBe(o.id);
    expect((await call('GET', `/api/issues/${plain.id}`)).body.ownerId).toBe(o.id); // dealt afresh, the only owner again
  });

  it('only a closed task cannot be auto-assigned', async () => {
    const o = await owner('Ann');
    const m = await mod('M', { ownerIds: [o.id] });
    const s = (await call('POST', '/api/sprints', { name: 'S' })).body;
    const t = await task('t', { sprintId: s.id, moduleId: m.id, state: 'test_validation' });
    expect((await call('POST', `/api/issues/${t.id}/assign`)).status).toBe(200);
    const d = await task('d', { sprintId: s.id, moduleId: m.id, state: 'closed' });
    expect((await call('POST', `/api/issues/${d.id}/assign`)).status).toBe(400);
  });

  it('upgrades a database that only knows open and closed, keeping every row, idempotently', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-'));
    const file = path.join(dir, 'two-states.db');
    const first = buildApp(file);
    await first.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });
    const modId = (await first.inject({ method: 'POST', url: '/api/modules', payload: { name: 'M' } })).json().id;
    await first.inject({ method: 'POST', url: '/api/issues', payload: { type: 'epic', title: 'E' } });
    await first.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: 'T', state: 'closed', parentId: 1, moduleId: modId } });
    await first.close();
    // Put the table back the way an older version made it: the two-state CHECK.
    const raw = new Database(file);
    raw.pragma('foreign_keys = OFF');
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'issues'").get() as { sql: string }).sql;
    raw.exec(`DROP INDEX IF EXISTS issues_jira_key; ALTER TABLE issues RENAME TO issues_old;
      ${sql.replace("'open','code_review','test_validation','closed'", "'open','closed'")};
      INSERT INTO issues SELECT * FROM issues_old; DROP TABLE issues_old;`);
    raw.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const list = (await a.inject({ method: 'GET', url: '/api/issues' })).json();
      expect(list.map((x: any) => [x.id, x.state, x.parentId])).toEqual([[1, 'open', null], [2, 'closed', 1]]);
      const r = await a.inject({ method: 'POST', url: '/api/issues', payload: { type: 'task', title: 'R', state: 'code_review', moduleId: 1 } });
      expect(r.statusCode).toBe(201);
      await a.close();
      const chk = new Database(file);
      chk.prepare('DELETE FROM issues WHERE id = 3').run();
      expect((chk.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'issues_jira_key'").get() as any)?.name).toBe('issues_jira_key');
      chk.close();
    }
  });
});

describe('module test coverage', () => {
  it('stores testStatus/testNotes, leaves them on omitted PUT, clears with null, rejects bad values', async () => {
    const app = buildApp(':memory:');
    await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'P' } });
    const c = await app.inject({ method: 'POST', url: '/api/modules', payload: { name: 'A', testStatus: 'partial', testNotes: 'vitest in test/' } });
    expect(c.statusCode).toBe(201);
    const m = c.json();
    expect(m).toMatchObject({ testStatus: 'partial', testNotes: 'vitest in test/' });
    const kept = await app.inject({ method: 'PUT', url: `/api/modules/${m.id}`, payload: { name: 'A2' } });
    expect(kept.json()).toMatchObject({ name: 'A2', testStatus: 'partial', testNotes: 'vitest in test/' });
    const cleared = await app.inject({ method: 'PUT', url: `/api/modules/${m.id}`, payload: { name: 'A2', testStatus: null } });
    expect(cleared.json().testStatus).toBeNull();
    const bad = await app.inject({ method: 'PUT', url: `/api/modules/${m.id}`, payload: { name: 'A2', testStatus: 'lots' } });
    expect(bad.statusCode).toBe(400);
  });
});
