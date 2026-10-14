import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { obj, id, colorField, labelOf } from '../validation.js';
import { moduleStore } from './modules.js';
export const relRow = (r: any) => ({ id: r.id, sourceId: r.source_id, targetId: r.target_id, label: r.label, color: r.color ?? null });

export function relationStore(db: Database.Database) {
  const getRel = (rid: number) => {
    const r = db.prepare('SELECT r.* FROM relations r JOIN modules m ON m.id = r.source_id WHERE r.id = ? AND m.project_id = ?').get(rid, P());
    if (!r) throw notFound('Relation');
    return relRow(r);
  };
  const relList = () => (db.prepare('SELECT r.* FROM relations r JOIN modules m ON m.id = r.source_id WHERE m.project_id = ? ORDER BY r.id').all(P()) as any[]).map(relRow);
  return { getRel, relList };
}

export function relationRoutes(app: FastifyInstance, db: Database.Database) {
  const { getRel, relList } = relationStore(db);
  const { moduleExists } = moduleStore(db);
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
}
