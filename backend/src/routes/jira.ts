import type { FastifyInstance } from 'fastify';
import { HttpError, bad, conflict } from '../errors.js';
import { obj } from '../validation.js';
import { jiraConfig, jiraTest, JiraError, writeEnv } from '../jira.js';
import { parseJql, parseLabel, effectiveJql, runFilter, planImport } from '../jiraSync.js';

// The shared Jira account's URL and token live in the environment only (JIRA_URL, JIRA_TOKEN); with either unset the
// integration is off. Status never calls Jira. Everything else is POST and needs the write key like any other action.
export const jira = () => {
  const cfg = jiraConfig();
  if (!cfg) throw conflict('Jira is not configured: set JIRA_URL and JIRA_TOKEN in .env');
  return cfg;
};
export const viaJira = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof JiraError) {
      if (e.status === 400) throw bad(e.message);
      throw new HttpError(e.status === 404 ? 404 : 502, e.status === 404 ? 'not_found' : 'jira_error', e.message);
    }
    throw e;
  }
};

// Every write endpoint passes through here: JIRA_WRITE, credentials and the project's own switch must all be on.
export const jiraEnabledGate = (project: { jira_enabled?: number }) => {
  if (!project.jira_enabled) throw conflict('Jira is disabled for this project');
};
export const jiraWriteGate = (project: { jira_write?: number; jira_enabled?: number }) => {
  jiraEnabledGate(project);
  const w = writeEnv();
  if (!w.enabled) throw conflict('Writing to Jira is disabled: set JIRA_WRITE=1 in .env');
  const cfg = jira();
  if (!project.jira_write) throw conflict('Writing to Jira is not enabled for this project');
  return { cfg };
};

export function jiraRoutes(app: FastifyInstance) {
  app.get('/api/jira/status', async () => {
    const cfg = jiraConfig();
    const w = writeEnv();
    // `missing` names what the server lacks to use Jira at all (JIRA_WRITE only concerns writing, see writeAllowed).
    const missing = ['JIRA_URL', 'JIRA_TOKEN'].filter((k) => !(process.env[k] ?? '').trim());
    return { configured: Boolean(cfg), available: Boolean(cfg), missing: cfg ? [] : missing, url: cfg?.url ?? null, writeAllowed: w.enabled };
  });
  app.post('/api/jira/test', async () => viaJira(() => jiraTest(jira())));

  // Shows what a filter would import without writing anything.
  app.post('/api/jira/preview', async (req) => {
    const b = obj(req.body);
    const jql = effectiveJql(b.jql == null ? null : parseJql(b.jql), b.label == null ? null : parseLabel(b.label));
    return viaJira(async () => {
      const { total, found, links } = await runFilter(jira(), jql);
      const plan = planImport(found, links);
      const byType: Record<string, number> = {};
      for (const i of found) byType[i.fields.issuetype?.name ?? 'unknown'] = (byType[i.fields.issuetype?.name ?? 'unknown'] ?? 0) + 1;
      return {
        jql, total, byType, importable: plan.issues.length, skipped: plan.skipped,
        sample: plan.issues.slice(0, 10).map((i) => ({ key: i.key, type: i.type, title: i.title, state: i.state, parentKey: i.parentKey })),
      };
    });
  });
}
