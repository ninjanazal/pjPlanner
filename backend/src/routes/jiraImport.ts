import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { bad, notFound } from '../errors.js';
import { id } from '../validation.js';
import { jira, jiraEnabledGate, viaJira } from './jira.js';
import { jiraTiming } from './issues.js';
import { migrateIssueTypes } from '../db/migrations.js';
import { effectiveJql, planImport, runFilter } from '../jiraSync.js';

// Import only reads from Jira (writing lives in jiraExport.ts). Re-running updates what was imported (matched on jira_key) and never duplicates.
// An issue pjPlanner already has with no Jira key (e.g. after a project import, which drops keys) is adopted when a Jira issue has the
// same type and title, instead of being duplicated.
// Title, description, type, state and parent follow Jira; what only pjPlanner knows (module, assignee, sprint, estimate) is kept.
export function jiraImportRoutes(app: FastifyInstance, db: Database.Database) {
  app.post('/api/projects/:id/jira/import', async (req) => {
    const pid = id((req.params as any).id);
    const proj = db.prepare('SELECT jira_jql, jira_label, jira_enabled FROM projects WHERE id = ?').get(pid) as { jira_jql: string | null; jira_label: string | null; jira_enabled: number } | undefined;
    if (!proj) throw notFound('Project');
    jiraEnabledGate(proj);
    if (!proj.jira_jql && !proj.jira_label) throw bad('this project has no Jira filter; set a JQL or a label first');
    const saved = effectiveJql(proj.jira_jql, proj.jira_label);
    // Stamped from before the fetch: an edit made in Jira while the import runs must still count as newer than this sync.
    // Same shape as SQLite's CURRENT_TIMESTAMP (UTC, whole seconds, rounded down).
    const syncedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    return viaJira(async () => {
      const { total, found, links } = await runFilter(jira(), saved);
      const plan = planImport(found, links);
      return db.transaction(() => {
        const known = new Map((db.prepare('SELECT id, jira_key FROM issues WHERE project_id = ? AND jira_key IS NOT NULL').all(pid) as { id: number; jira_key: string }[])
          .map((r) => [r.jira_key, r.id]));
        const ids = new Map<string, number>();
        const unlinked = new Map<string, number[]>();
        for (const r of db.prepare('SELECT id, type, title FROM issues WHERE project_id = ? AND jira_key IS NULL ORDER BY id').all(pid) as { id: number; type: string; title: string }[]) {
          const k = `${r.type}\n${r.title.trim().toLowerCase()}`;
          unlinked.set(k, [...(unlinked.get(k) ?? []), r.id]);
        }
        let created = 0, updated = 0, linked = 0;
        const ins = db.prepare('INSERT INTO issues (project_id, type, title, description, state, jira_key, jira_synced_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        // Jira does not tell when work happened, so imports never record a close time (see jiraTiming); the row's own sync time
        // moves with the import so a later project-wide import cannot hide a Jira edit made to an issue it did not touch.
        const upd = db.prepare('UPDATE issues SET jira_key = ?, type = ?, title = ?, description = ?, state = ?, closed_at = ?, closed_owner_id = ?, reopen_count = ?, updated_at = ?, jira_synced_at = ? WHERE id = ?');
        const rowOf = db.prepare('SELECT * FROM issues WHERE id = ?');
        // Only tasks carry a module, assignee, sprint and estimate.
        const clear = db.prepare('UPDATE issues SET owner_id = NULL, module_id = NULL, sprint_id = NULL, estimate = NULL WHERE id = ?');
        for (const i of plan.issues) {
          let existing = known.get(i.key);
          if (existing === undefined) {
            existing = unlinked.get(`${i.type}\n${i.title.trim().toLowerCase()}`)?.shift();
            if (existing !== undefined) linked++;
          }
          if (existing === undefined) {
            ids.set(i.key, Number(ins.run(pid, i.type, i.title, i.description, i.state, i.key, syncedAt, jiraTiming(null, i.state).now).lastInsertRowid));
            created++;
          } else {
            const tm = jiraTiming(rowOf.get(existing), i.state);
            upd.run(i.key, i.type, i.title, i.description, i.state, tm.closedAt, tm.closedOwner, tm.reopens, tm.now, syncedAt, existing);
            if (i.type !== 'task') clear.run(existing);
            ids.set(i.key, existing);
            if (known.has(i.key)) updated++;
          }
        }
        // Parents once every issue exists, so the order Jira returned them in does not matter.
        const link = db.prepare('UPDATE issues SET parent_id = ? WHERE id = ?');
        for (const i of plan.issues) link.run(i.parentKey ? ids.get(i.parentKey) ?? null : null, ids.get(i.key));
        // A retyped issue may leave local-only children under a parent that can no longer hold them: move those up.
        migrateIssueTypes(db);
        db.prepare('UPDATE projects SET jira_synced_at = ? WHERE id = ?').run(syncedAt, pid);
        const notInFilter = [...known.keys()].filter((k) => !ids.has(k)).length;
        return { jql: saved, total, created, updated, linked, skipped: plan.skipped, notInFilter };
      })();
    });
  });
}
