import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { obj, id } from '../validation.js';
import { ownerRow, ownerStore, parseOwner } from './owners.js';
export const groupRow = (r: any) => ({ ...ownerRow(r), parentId: r.parent_id ?? null });

export function groupStore(db: Database.Database) {
  const getGroup = (gid: number) => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ? AND project_id = ?').get(gid, P());
    if (!g) throw notFound('Group');
    return groupRow(g);
  };
  const groupList = () => (db.prepare('SELECT * FROM groups WHERE project_id = ? ORDER BY id').all(P()) as any[]).map(groupRow);
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
  return { getGroup, groupList, checkParent };
}

export function groupRoutes(app: FastifyInstance, db: Database.Database) {
  const { getGroup, groupList, checkParent } = groupStore(db);
  const { checkNameFree } = ownerStore(db);
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
}
