import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { bad, notFound } from '../errors.js';
import { projectScope } from '../context.js';
import { Body, obj, str, id, colorField, labelOf } from '../validation.js';
import { ownerStore, parseOwner } from './owners.js';
import { groupStore } from './groups.js';
import { moduleStore } from './modules.js';
import { relationStore } from './relations.js';
import { SPRINT_STATES } from './sprints.js';
import { ISSUE_TYPES, ISSUE_STATES, PARENTS } from './issues.js';
import { projectStore } from './projects.js';
export function projectTransferRoutes(app: FastifyInstance, db: Database.Database) {
  const { ownerList } = ownerStore(db);
  const { groupList, checkParent } = groupStore(db);
  const { modules, parseExtras, setItems } = moduleStore(db);
  const { relList } = relationStore(db);
  const { getProject, freeProjectName } = projectStore(db);
  // Export: one self-contained JSON file. Ids in the file are only labels for cross references; import remaps them.
  const FORMAT = 'pjplanner-project';
  app.get('/api/projects/:id/export', async (req, reply) => {
    const pid = id((req.params as any).id);
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid) as any;
    if (!proj) throw notFound('Project');
    const data = projectScope.run(pid, () => ({
      format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
      project: { name: proj.name, description: proj.description },
      owners: ownerList(),
      groups: groupList(),
      modules: modules(),
      relations: relList(),
      sprints: (db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY id').all(pid) as any[]).map((s) => ({ id: s.id, name: s.name, goal: s.goal, state: s.state })),
      issues: (db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY id').all(pid) as any[]).map((r) => ({
        id: r.id, type: r.type, title: r.title, description: r.description, implementation: r.implementation ?? '', state: r.state,
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
      return projectScope.run(pid, () => {
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
        const mins = db.prepare('INSERT INTO modules (project_id, name, description, color, icon, text_color, stroke_color, stroke_style, x, y, group_id, test_status, test_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const m of mods) {
          const { ownerIds: _o, groupId: _g, ...rest } = m as any;
          const p = { name: str(m.name, 'module name'), description: typeof m.description === 'string' ? m.description : '', ...parseExtras({ ...rest, apiItems: (m.apiItems ?? []) as unknown[] }) };
          const x = typeof m.x === 'number' && Number.isFinite(m.x) ? m.x : null;
          const y = typeof m.y === 'number' && Number.isFinite(m.y) ? m.y : null;
          const mid = Number(mins.run(pid, p.name, p.description, p.color ?? null, p.icon ?? null, p.textColor ?? null, p.strokeColor ?? null, p.strokeStyle ?? 'solid', x, y,
            ref(groupMap, m.groupId, `modules[${m.id}].groupId`), p.testStatus ?? null, p.testNotes ?? '').lastInsertRowid);
          modMap.set(m.id as number, mid);
          setItems(mid, (p.apiItems ?? []).map(({ id: _i, ...it }) => it));
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
        const iins = db.prepare('INSERT INTO issues (project_id, type, title, description, implementation, owner_id, module_id, sprint_id, state, estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (const i of issues) {
          if (typeof i.type !== 'string' || !ISSUE_TYPES.includes(i.type)) throw bad(`issues[${i.id}].type is invalid`);
          const state = i.state === undefined ? 'open' : i.state;
          if (typeof state !== 'string' || !ISSUE_STATES.includes(state)) throw bad(`issues[${i.id}].state is invalid`);
          const task = i.type === 'task';
          issueMap.set(i.id as number, Number(iins.run(pid, i.type, str(i.title, 'issue title'), typeof i.description === 'string' ? i.description : '',
            task && typeof i.implementation === 'string' ? i.implementation : '',
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
}
