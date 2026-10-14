import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, notFound } from '../errors.js';
import { Body, obj, str, id } from '../validation.js';
import { parseUploadConfig, readUploadConfig } from '../jiraMeta.js';
import { parseJql, parseLabel, parseJiraProjectId } from '../jiraSync.js';
export function projectStore(db: Database.Database) {
  const projectRow = (r: any) => {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).get(r.id) as { n: number }).n;
    return { id: r.id, name: r.name, description: r.description, createdAt: r.created_at, moduleCount: n('modules'), issueCount: n('issues'), sprintCount: n('sprints'), jiraJql: (r.jira_jql ?? null) as string | null, jiraLabel: (r.jira_label ?? null) as string | null,
      jiraProjectId: (r.jira_project_id ?? null) as string | null, jiraWrite: Boolean(r.jira_write), jiraUploadConfig: readUploadConfig(r.jira_upload_config), jiraEnabled: Boolean(r.jira_enabled), jiraSyncedAt: (r.jira_synced_at ?? null) as string | null }; // UTC, like createdAt
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
    // jiraJql / jiraLabel: omitted = unchanged, null = clear.
    const jiraJql = b.jiraJql === undefined ? undefined : b.jiraJql === null ? null : parseJql(b.jiraJql);
    const jiraLabel = b.jiraLabel === undefined ? undefined : b.jiraLabel === null ? null : parseLabel(b.jiraLabel);
    const jiraProjectId = b.jiraProjectId === undefined ? undefined : b.jiraProjectId === null ? null : parseJiraProjectId(b.jiraProjectId);
    const jiraUploadConfig = b.jiraUploadConfig === undefined ? undefined : b.jiraUploadConfig === null ? null : parseUploadConfig(b.jiraUploadConfig);
    if (b.jiraWrite !== undefined && typeof b.jiraWrite !== 'boolean') throw bad('jiraWrite must be a boolean');
    if (b.jiraEnabled !== undefined && typeof b.jiraEnabled !== 'boolean') throw bad('jiraEnabled must be a boolean');
    return { name, description: (b.description as string | undefined) ?? existing?.description ?? '', jiraJql, jiraLabel, jiraProjectId, jiraUploadConfig, jiraWrite: b.jiraWrite as boolean | undefined, jiraEnabled: b.jiraEnabled as boolean | undefined };
  };
  const projectNameTaken = (name: string, exceptId = 0) =>
    (db.prepare('SELECT name FROM projects WHERE id <> ?').all(exceptId) as { name: string }[]).some((r) => r.name.toLowerCase() === name.toLowerCase());
  const freeProjectName = (name: string) => {
    if (!projectNameTaken(name)) return name;
    for (let n = 2; ; n++) if (!projectNameTaken(`${name} (${n})`)) return `${name} (${n})`;
  };
  return { projectRow, getProject, parseProject, projectNameTaken, freeProjectName };
}

export function projectRoutes(app: FastifyInstance, db: Database.Database) {
  const { projectRow, getProject, parseProject, projectNameTaken } = projectStore(db);
  app.get('/api/projects', async () => (db.prepare('SELECT * FROM projects ORDER BY id').all() as any[]).map(projectRow));
  app.post('/api/projects', async (req, reply) => {
    const p = parseProject(obj(req.body));
    if (projectNameTaken(p.name)) throw new HttpError(409, 'conflict', 'A project with this name already exists');
    const r = db.prepare('INSERT INTO projects (name, description, jira_jql, jira_label, jira_project_id, jira_write, jira_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.name, p.description, p.jiraJql ?? null, p.jiraLabel ?? null, p.jiraProjectId ?? null, p.jiraWrite ? 1 : 0, p.jiraEnabled ? 1 : 0);
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
    if (p.jiraJql !== undefined) db.prepare('UPDATE projects SET jira_jql = ? WHERE id = ?').run(p.jiraJql, pid);
    if (p.jiraLabel !== undefined) db.prepare('UPDATE projects SET jira_label = ? WHERE id = ?').run(p.jiraLabel, pid);
    if (p.jiraProjectId !== undefined) db.prepare('UPDATE projects SET jira_project_id = ? WHERE id = ?').run(p.jiraProjectId, pid);
    if (p.jiraUploadConfig !== undefined) db.prepare('UPDATE projects SET jira_upload_config = ? WHERE id = ?').run(p.jiraUploadConfig === null ? null : JSON.stringify(p.jiraUploadConfig), pid);
    if (p.jiraWrite !== undefined) db.prepare('UPDATE projects SET jira_write = ? WHERE id = ?').run(p.jiraWrite ? 1 : 0, pid);
    if (p.jiraEnabled !== undefined) db.prepare('UPDATE projects SET jira_enabled = ? WHERE id = ?').run(p.jiraEnabled ? 1 : 0, pid);
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
}
