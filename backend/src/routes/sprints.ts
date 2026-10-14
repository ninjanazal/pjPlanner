import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, str, id } from '../validation.js';
export const SPRINT_STATES = ['planned', 'active', 'closed'];

export function sprintStore(db: Database.Database) {
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
      openCount: issues.filter((i) => i.state !== 'closed').length, // unfinished: open, in review or in validation
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
  // Gives every unassigned open task of a sprint an owner, balancing the team. Rules:
  //  1. only the task's own module owners may take it (no module / no owners: left alone);
  //  2. least-loaded owner wins, counting what each already carries in this sprint;
  //  3. continuity: whoever already holds a task of the same module counts as 2 lighter, so a module's tasks tend to stay
  //     with one person (about 3 in a row), and a task under the same epic/bug counts as 0.5 lighter;
  //  4. fairness cap: nobody goes above the sprint average (rounded up) + 1 while someone else in the pool is below it;
  //  5. narrowest choices are placed first, ties go to the lowest owner id, existing assignments are never moved.
  const balanceOwners = (sid: number, onlyId?: number) => {
    const rows = db.prepare("SELECT id, owner_id, module_id, parent_id FROM issues WHERE sprint_id = ? AND type = 'task' AND state <> 'closed' ORDER BY id").all(sid) as any[];
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
  return { sprintPayloads, getSprint, parseSprint, balanceOwners };
}

export function sprintRoutes(app: FastifyInstance, db: Database.Database) {
  const { sprintPayloads, getSprint, parseSprint, balanceOwners } = sprintStore(db);
  app.get('/api/sprints', async () => sprintPayloads(db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY id').all(P())));
  app.post('/api/sprints', async (req, reply) => {
    const sp = parseSprint(obj(req.body), null);
    if (sp.state === 'closed') throw bad('a new sprint cannot start closed');
    const r = db.prepare('INSERT INTO sprints (project_id, name, goal, state) VALUES (?, ?, ?, ?)')
      .run(P(), sp.name, sp.goal, sp.state);
    return reply.status(201).send(getSprint(Number(r.lastInsertRowid)));
  });
  app.get('/api/sprints/:id', async (req) => getSprint(id((req.params as any).id)));
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
        db.prepare("UPDATE issues SET sprint_id = NULL WHERE sprint_id = ? AND state <> 'closed'").run(sid);
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
}
