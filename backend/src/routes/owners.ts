import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, str, colorField, iconField, id } from '../validation.js';
export const ownerRow = (r: any) => ({ id: r.id, name: r.name, color: r.color ?? null, icon: r.icon ?? null });

export function parseOwner(b: Body) {
  const name = str(b.name, 'name');
  if (name.length > 200) throw bad('name must be at most 200 characters');
  return { name, color: colorField(b, 'color'), icon: iconField(b) };
}

export function ownerStore(db: Database.Database) {
  const getOwner = (oid: number) => {
    const o = db.prepare('SELECT * FROM owners WHERE id = ? AND project_id = ?').get(oid, P());
    if (!o) throw notFound('Owner');
    return ownerRow(o);
  };
  const ownerList = () => (db.prepare('SELECT * FROM owners WHERE project_id = ? ORDER BY id').all(P()) as any[]).map(ownerRow);
  // Uniqueness is enforced here only: existing data may already contain duplicate names.
  const checkNameFree = (name: string, exceptId = 0, table: 'owners' | 'groups' = 'owners') => {
    const lower = name.toLowerCase();
    const rows = db.prepare(`SELECT name FROM ${table} WHERE id <> ? AND project_id = ?`).all(exceptId, P()) as { name: string }[];
    if (rows.some((r) => r.name.toLowerCase() === lower)) {
      throw new HttpError(409, 'conflict', `A ${table === 'owners' ? 'owner' : 'group'} with this name already exists`);
    }
  };
  return { getOwner, ownerList, checkNameFree };
}

export function ownerRoutes(app: FastifyInstance, db: Database.Database) {
  const { getOwner, ownerList, checkNameFree } = ownerStore(db);
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
}
