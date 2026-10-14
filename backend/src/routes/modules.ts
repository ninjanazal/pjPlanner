import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { bad, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, str, colorField, iconField, id } from '../validation.js';
type ApiItemInput = { id?: number; kind: string; name: string; signature: string; description: string };
const KINDS = ['function', 'endpoint', 'event', 'type', 'other'];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
const TEST_STATUSES = ['none', 'partial', 'full'];

export function moduleStore(db: Database.Database) {
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
      testStatus: m.test_status ?? null, testNotes: m.test_notes ?? '',
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
    let testStatus: string | null | undefined;
    if (b.testStatus !== undefined) {
      if (b.testStatus !== null && (typeof b.testStatus !== 'string' || !TEST_STATUSES.includes(b.testStatus))) {
        throw bad(`testStatus must be null or one of ${TEST_STATUSES.join(', ')}`);
      }
      testStatus = b.testStatus as string | null;
    }
    let testNotes: string | undefined;
    if (b.testNotes !== undefined) {
      if (typeof b.testNotes !== 'string' || b.testNotes.length > 5000) throw bad('testNotes must be a string of at most 5000 characters');
      testNotes = b.testNotes;
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
    return { color, icon, textColor, strokeColor, strokeStyle, testStatus, testNotes, apiItems, groupId };
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
  return { modules, getModule, moduleExists, parseModule, parseExtras, setItems, setOwners };
}

export function moduleRoutes(app: FastifyInstance, db: Database.Database) {
  const { modules, getModule, moduleExists, parseModule, setItems, setOwners } = moduleStore(db);
  app.get('/api/modules', async () => modules());
  app.post('/api/modules', async (req, reply) => {
    const m = parseModule(obj(req.body));
    const mid = db.transaction(() => {
      const r = db.prepare('INSERT INTO modules (project_id, name, description, color, icon, text_color, stroke_color, stroke_style, group_id, test_status, test_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(P(), m.name, m.description, m.color ?? null, m.icon ?? null, m.textColor ?? null, m.strokeColor ?? null, m.strokeStyle ?? 'solid', m.groupId ?? null, m.testStatus ?? null, m.testNotes ?? '');
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
      if (m.testStatus !== undefined) db.prepare('UPDATE modules SET test_status = ? WHERE id = ?').run(m.testStatus, mid);
      if (m.testNotes !== undefined) db.prepare('UPDATE modules SET test_notes = ? WHERE id = ?').run(m.testNotes, mid);
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
}
