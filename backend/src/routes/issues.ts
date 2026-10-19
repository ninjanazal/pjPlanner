import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, str, id } from '../validation.js';
import { sprintStore } from './sprints.js';
export const ISSUE_TYPES = ['epic', 'story', 'bug', 'task'];
// Epics, stories and bugs hold children: an epic holds stories, bugs and tasks; a story or a bug holds tasks.
export const PARENTS: Record<string, string[]> = { epic: [], story: ['epic'], bug: ['epic'], task: ['epic', 'story', 'bug'] };
// open -> code_review -> test_validation -> closed. Anything but closed is unfinished work.
export const ISSUE_STATES = ['open', 'code_review', 'test_validation', 'closed'];

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const iso = (v: unknown) => (typeof v === 'string' && v ? `${v.replace(' ', 'T')}Z` : null);

// Timing columns after a state change: first time in review/validation = started, entering closed = closed (by the owner
// at that moment), leaving closed = a reopen. `now` is also the last-change time.
export function timing(existing: any | null, state: string, ownerId: number | null, now = nowSql()) {
  const was = existing?.state as string | undefined;
  const started = existing?.started_at ?? (state === 'code_review' || state === 'test_validation' ? now : null);
  let closedAt = existing?.closed_at ?? null, closedOwner = existing?.closed_owner_id ?? null, reopens = existing?.reopen_count ?? 0;
  if (state === 'closed' && was !== 'closed') { closedAt = now; closedOwner = ownerId; }
  else if (state !== 'closed' && was === 'closed') { closedAt = null; closedOwner = null; reopens++; }
  return { started, closedAt, closedOwner, reopens, now };
}

// Columns that follow a state pulled from Jira. Jira does not say when work happened, so a close time and closer are never
// recorded (kept if already closed, cleared on leaving closed), but a reopen is still counted.
export function jiraTiming(existing: any | null, state: string) {
  const closed = state === 'closed';
  return {
    closedAt: closed ? existing?.closed_at ?? null : null,
    closedOwner: closed ? existing?.closed_owner_id ?? null : null,
    reopens: (existing?.reopen_count ?? 0) + (existing?.state === 'closed' && !closed ? 1 : 0),
    now: nowSql(),
  };
}

export function issueStore(db: Database.Database) {
  const { balanceOwners } = sprintStore(db);
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
      id: r.id, type: r.type, title: r.title, description: r.description, implementation: r.implementation ?? '',
      parentId: r.parent_id ?? null, ownerId: r.owner_id ?? null, moduleId: r.module_id ?? null, sprintId: r.sprint_id ?? null, estimate: r.estimate ?? null, state: r.state, jiraKey: r.jira_key ?? null,
      createdAt: iso(r.created_at), startedAt: iso(r.started_at), closedAt: iso(r.closed_at), closedOwnerId: r.closed_owner_id ?? null, reopenCount: r.reopen_count ?? 0, updatedAt: iso(r.updated_at ?? r.created_at),
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
    // implementation (how-to notes): tasks only; omitted keeps the current text.
    if (b.implementation !== undefined && typeof b.implementation !== 'string') throw bad('implementation must be a string');
    if (b.type !== 'task' && b.implementation) throw bad(`a${b.type === 'epic' ? 'n' : ''} ${b.type} cannot have implementation notes; write them on its tasks`);
    const implementation = b.type !== 'task' ? '' : ((b.implementation as string | undefined) ?? existing?.implementation ?? '');
    const type = b.type;
    const parentId = optId(b.parentId, 'parentId');
    const ownerId = optId(b.ownerId, 'ownerId');
    const moduleId = optId(b.moduleId, 'moduleId');
    // Epics and bugs only group work; the module and the assignee live on the tasks.
    if (b.type !== 'task' && (ownerId != null || moduleId != null)) throw bad(`a${b.type === 'epic' ? 'n' : ''} ${b.type} cannot have an assignee or a module; set them on its tasks`);
    // Every task belongs to exactly one module. Old tasks that never had one stay editable; a module cannot be taken away once set.
    if (b.type === 'task' && moduleId == null && (!existing || existing.type !== 'task' || existing.module_id != null)) throw bad('a task needs a module (moduleId)');
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
    return { type, title, description: (b.description as string | undefined) ?? '', implementation, parentId, ownerId, moduleId, sprintId, state, estimate: b.type === 'task' ? (estimate as number | null) : null };
  };
  // A task that lands in a sprint that is already running gets an owner straight away (same rules as starting it).
  const joinedRunningSprint = (sprintId: number | null) => {
    if (sprintId != null && (db.prepare('SELECT state FROM sprints WHERE id = ? AND project_id = ?').get(sprintId, P()) as any)?.state === 'active') balanceOwners(sprintId);
  };
  return { issuePayloads, getIssue, parseIssue, joinedRunningSprint };
}

export function issueRoutes(app: FastifyInstance, db: Database.Database) {
  const { balanceOwners } = sprintStore(db);
  const { issuePayloads, getIssue, parseIssue, joinedRunningSprint } = issueStore(db);
  app.get('/api/issues', async () => issuePayloads());
  app.post('/api/issues', async (req, reply) => {
    const i = parseIssue(obj(req.body), null);
    const tm = timing(null, i.state, i.ownerId);
    const r = db.prepare('INSERT INTO issues (project_id, type, title, description, implementation, parent_id, owner_id, module_id, sprint_id, state, estimate, started_at, closed_at, closed_owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(P(), i.type, i.title, i.description, i.implementation, i.parentId, i.ownerId, i.moduleId, i.sprintId, i.state, i.estimate, tm.started, tm.closedAt, tm.closedOwner, tm.now);
    joinedRunningSprint(i.sprintId);
    return reply.status(201).send(getIssue(Number(r.lastInsertRowid)));
  });
  app.get('/api/issues/:id', async (req) => getIssue(id((req.params as any).id)));
  // Picks the best owner for one task with the sprint-balancing rules (it must be an open task in a sprint).
  app.post('/api/issues/:id/assign', async (req) => {
    const iid = id((req.params as any).id);
    const row = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P()) as any;
    if (!row) throw notFound('Issue');
    if (row.type !== 'task' || row.state === 'closed') throw bad('only an unfinished task can be assigned');
    if (row.sprint_id == null) throw bad('add the task to a sprint first; owners are balanced within a sprint');
    if (row.owner_id == null) balanceOwners(row.sprint_id, iid);
    return getIssue(iid);
  });
  app.put('/api/issues/:id', async (req) => {
    const iid = id((req.params as any).id);
    const existing = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P()) as any;
    if (!existing) throw notFound('Issue');
    const i = parseIssue(obj(req.body), existing);
    const tm = timing(existing, i.state, i.ownerId);
    db.prepare('UPDATE issues SET type = ?, title = ?, description = ?, implementation = ?, parent_id = ?, owner_id = ?, module_id = ?, sprint_id = ?, state = ?, estimate = ?, started_at = ?, closed_at = ?, closed_owner_id = ?, reopen_count = ?, updated_at = ? WHERE id = ?')
      .run(i.type, i.title, i.description, i.implementation, i.parentId, i.ownerId, i.moduleId, i.sprintId, i.state, i.estimate, tm.started, tm.closedAt, tm.closedOwner, tm.reopens, tm.now, iid);
    if (i.sprintId !== existing.sprint_id) joinedRunningSprint(i.sprintId); // only on entering, so a deliberate "unassigned" sticks
    return getIssue(iid);
  });
  app.delete('/api/issues/:id', async (req, reply) => {
    const iid = id((req.params as any).id);
    getIssue(iid);
    db.prepare('DELETE FROM issues WHERE id = ?').run(iid);
    return reply.status(204).send();
  });
}
