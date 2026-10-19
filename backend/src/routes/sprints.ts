import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, str, id } from '../validation.js';
export const SPRINT_STATES = ['planned', 'active', 'closed'];
const EXPERIENCE_BONUS = 4, EXPERIENCE_HALF = 5; // bonus = BONUS * n / (n + HALF) for n closed tasks

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
  //  1. tasks under the same story or bug form one unit and go to one person; any other task is a unit of its own;
  //  2. if a task of the unit already has an owner (in any sprint), the rest of the unit follows that owner;
  //  3. otherwise the owner with the best score wins: the work already carried in this sprint (sum of task estimates, 1 step
  //     when unset) minus an experience bonus, i.e. the tasks that owner closed before in the unit's modules (saturating,
  //     worth at most EXPERIENCE_BONUS steps, so a veteran is favoured but never buried);
  //  4. the biggest units are placed first, ties go to the lowest owner id, existing assignments are never moved;
  //  5. `shuffle` adds a little randomness to the order and the scores, so asking again gives another (still balanced) split.
  const balanceOwners = (sid: number, onlyId?: number, shuffle = false) => {
    const people = (db.prepare('SELECT id FROM owners WHERE project_id = ? ORDER BY id').all(P()) as { id: number }[]).map((o) => o.id);
    if (people.length === 0) return;
    const rows = db.prepare("SELECT id, owner_id, parent_id, module_id, estimate FROM issues WHERE sprint_id = ? AND type = 'task' AND state <> 'closed' ORDER BY id").all(sid) as any[];
    const groupParent = db.prepare("SELECT 1 FROM issues WHERE id = ? AND type IN ('story', 'bug')");
    const unitOf = (r: any) => (r.parent_id != null && groupParent.get(r.parent_id) ? `p${r.parent_id}` : `t${r.id}`);
    const weight = (r: any) => r.estimate ?? 1;
    const load = new Map<number, number>(people.map((o) => [o, 0]));
    for (const r of rows) if (r.owner_id != null) load.set(r.owner_id, (load.get(r.owner_id) ?? 0) + weight(r));

    // closed tasks per owner and module: who has fixed things in a module before
    const done = new Map<string, number>();
    for (const r of db.prepare("SELECT COALESCE(closed_owner_id, owner_id) AS o, module_id AS m, COUNT(*) AS n FROM issues WHERE project_id = ? AND type = 'task' AND state = 'closed' AND COALESCE(closed_owner_id, owner_id) IS NOT NULL AND module_id IS NOT NULL GROUP BY o, m").all(P()) as any[]) done.set(`${r.o}:${r.m}`, r.n);
    const bonus = (o: number, u: any[]) => {
      const n = [...new Set(u.map((r) => r.module_id).filter((m) => m != null))].reduce((t, m) => t + (done.get(`${o}:${m}`) ?? 0), 0);
      return (EXPERIENCE_BONUS * n) / (n + EXPERIENCE_HALF);
    };
    const units = new Map<string, any[]>();
    for (const r of rows) units.set(unitOf(r), [...(units.get(unitOf(r)) ?? []), r]);
    const heldBy = db.prepare("SELECT owner_id, COUNT(*) AS n FROM issues WHERE parent_id = ? AND type = 'task' AND state <> 'closed' AND owner_id IS NOT NULL GROUP BY owner_id ORDER BY n DESC, owner_id");
    const set = db.prepare('UPDATE issues SET owner_id = ? WHERE id = ?');
    const todo = [...units.entries()]
      .map(([key, members]) => ({ key, members, open: members.filter((r) => r.owner_id == null && (onlyId == null || r.id === onlyId)), tie: shuffle ? Math.random() : 0 }))
      .filter((u) => u.open.length > 0)
      .sort((a, b) => b.open.reduce((n, r) => n + weight(r), 0) - a.open.reduce((n, r) => n + weight(r), 0) || a.tie - b.tie || a.open[0].id - b.open[0].id);
    for (const u of todo) {
      const jitter = new Map(people.map((o) => [o, shuffle ? Math.random() * 1.5 : 0]));
      const follow = u.key.startsWith('p') ? (heldBy.all(Number(u.key.slice(1))) as { owner_id: number }[]).map((h) => h.owner_id).find((o) => load.has(o)) : undefined;
      const pick = follow ?? [...people].sort((x, y) => load.get(x)! - bonus(x, u.members) + jitter.get(x)! - (load.get(y)! - bonus(y, u.members) + jitter.get(y)!) || x - y)[0];
      for (const r of u.open) { set.run(pick, r.id); load.set(pick, load.get(pick)! + weight(r)); }
    }
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
    // ?reset=1 starts over: open tasks are cleared first, so everything is dealt out afresh.
    if ((req.query as any)?.reset === '1') {
      db.prepare("UPDATE issues SET owner_id = NULL WHERE sprint_id = ? AND type = 'task' AND state = 'open'").run(sid);
    }
    balanceOwners(sid, undefined, (req.query as any)?.shuffle === '1');
    return getSprint(sid);
  });
  // Clears the owners of the sprint's open (not yet started) tasks, e.g. to try another distribution.
  app.post('/api/sprints/:id/unassign', async (req) => {
    const sid = id((req.params as any).id);
    const sp = getSprint(sid);
    if (sp.state === 'closed') throw bad('a closed sprint keeps its owners');
    db.prepare("UPDATE issues SET owner_id = NULL WHERE sprint_id = ? AND type = 'task' AND state = 'open'").run(sid);
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
