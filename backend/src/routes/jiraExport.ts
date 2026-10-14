import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { HttpError, bad, conflict, notFound } from '../errors.js';
import { P } from '../context.js';
import { Body, obj, id, str } from '../validation.js';
import { JiraError, jiraCreateMeta, jiraFields, jiraGet, jiraLinkTypes, jiraPost, jiraProject, jiraPut, type JiraField, type JiraLinkType, type JiraIssue, type JiraProject } from '../jira.js';
import { effectiveJql, findMatch, linkFields, buildCreatePayload, defaultLinkType, jiraProjectRef, jiraTypeName, mapType, parseJiraProjectId, buildUpdatePayload, mapState, stripFootnote, planImport, runFilter, type LinkFields, type LocalType } from '../jiraSync.js';
import { applyUploadConfig, isLabel, normaliseFields, readUploadConfig, validateFields, withHiddenDefaults } from '../jiraMeta.js';
import { issueStore, jiraTiming } from './issues.js';
import { jira, jiraEnabledGate, jiraWriteGate, viaJira } from './jira.js';

type Cfg = Parameters<typeof jiraGet>[0];
const browseUrl = (cfg: Cfg, key: string) => `${cfg.url}/browse/${key}`;
// Jira prints "2026-01-02T03:04:05.000+0000" (sometimes with Z); the project's sync time is a UTC "YYYY-MM-DD HH:MM:SS". NaN when unreadable.
const parseTime = (s: string) => Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
// Issue type names are matched ignoring case, spaces and hyphens.
const norm = (t: string) => t.toLowerCase().replace(/[-\s]/g, '');

// Jira's `updated` of an issue, as the text Jira prints; null when it cannot be read (the next update then just conflicts, which is safe).
const fetchUpdated = async (cfg: Cfg, key: string): Promise<string | null> => {
  try {
    const r = await jiraGet<{ fields: { updated?: string } }>(cfg, `/rest/api/2/issue/${encodeURIComponent(key)}?fields=updated`);
    return r.fields.updated ?? null;
  } catch { return null; }
};

// The project's own spelling of an issue type, matched ignoring case, spaces and hyphens.
const resolveIssueType = <T extends { name: string }>(types: T[], wanted: string, where: string): T => {
  const actual = types.find((t) => norm(t.name) === norm(wanted));
  if (!actual) throw new HttpError(400, 'validation_error', `Jira project ${where} has no '${wanted}' issue type`);
  return actual;
};

type Target = { key: string } | { id: string };
const targetRef = (t: Target) => ('key' in t ? t.key : t.id); // either works in /rest/api/2/project/{idOrKey}

interface UploadForm {
  explicit: boolean; // any form value given; a bare POST keeps the original adopt-by-title-then-create behaviour
  projectRef?: string; issueType?: string; title?: string; description?: string; labels?: string[];
  fields?: Record<string, unknown>; linkExisting?: string; linkType?: string;
}

const parseUploadBody = (raw: unknown): UploadForm => {
  const b: Body = raw == null ? {} : obj(raw);
  const form: UploadForm = { explicit: ['projectRef', 'issueType', 'title', 'description', 'labels', 'fields', 'linkExisting', 'linkType'].some((k) => b[k] !== undefined) };
  const text = (k: string) => {
    if (typeof b[k] !== 'string') throw bad(`${k} must be a string`);
    return (b[k] as string).trim();
  };
  if (b.projectRef !== undefined) form.projectRef = parseJiraProjectId(b.projectRef);
  if (b.issueType !== undefined) form.issueType = str(b.issueType, 'issueType');
  if (b.title !== undefined) form.title = str(b.title, 'title');
  if (b.description !== undefined) form.description = text('description');
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || !b.labels.every(isLabel)) throw bad('labels must be a list of labels without spaces');
    form.labels = [...new Set((b.labels as string[]).map((l) => l.trim()))];
  }
  if (b.fields !== undefined) form.fields = obj(b.fields);
  if (b.linkType !== undefined) form.linkType = str(b.linkType, 'linkType');
  if (b.linkExisting !== undefined) {
    form.linkExisting = str(b.linkExisting, 'linkExisting');
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(form.linkExisting)) throw bad('linkExisting must be a Jira issue key such as PJ-45');
  }
  return form;
};

// Writes one issue at a time to Jira (create or adopt, then update). The Jira call always comes first; the local row only changes once it succeeded.
export function jiraExportRoutes(app: FastifyInstance, db: Database.Database) {
  const { getIssue } = issueStore(db);
  const load = (iid: number) => {
    const row = db.prepare('SELECT * FROM issues WHERE id = ? AND project_id = ?').get(iid, P()) as any;
    if (!row) throw notFound('Issue');
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(P()) as any;
    return { row, project };
  };

  const takenKeys = () => new Set((db.prepare('SELECT jira_key FROM issues WHERE project_id = ? AND jira_key IS NOT NULL').all(P()) as { jira_key: string }[]).map((r) => r.jira_key));
  const hasFilter = (project: any) => Boolean(project.jira_jql || project.jira_label);

  // Links an unlinked local issue to a Jira issue it corresponds to, copying Jira's content over it.
  const adopt = async (cfg: Cfg, row: any, match: JiraIssue, links: LinkFields) => {
    const p = planImport([match], links).issues[0];
    const syncedAt = typeof match.fields?.updated === 'string' ? match.fields.updated : await fetchUpdated(cfg, match.key);
    const tm = jiraTiming(row, p.state);
    db.prepare('UPDATE issues SET jira_key = ?, title = ?, description = ?, state = ?, closed_at = ?, closed_owner_id = ?, reopen_count = ?, updated_at = ?, jira_synced_at = ? WHERE id = ?')
      .run(match.key, p.title, p.description, p.state, tm.closedAt, tm.closedOwner, tm.reopens, tm.now, syncedAt, row.id);
    return { key: match.key, syncedAt };
  };

  // The issue the project's filter finds with the same type and title as the local one (and not linked locally already).
  const filterMatch = async (cfg: Cfg, project: any, row: any, fieldList?: JiraField[]) => {
    const { found, links } = await runFilter(cfg, effectiveJql(project.jira_jql, project.jira_label), fieldList);
    return { found, links, match: found.length ? findMatch(found, row.type as LocalType, row.title, takenKeys()) : null };
  };

  const tryAdopt = async (cfg: Cfg, project: any, row: any) => {
    const { links, match } = await filterMatch(cfg, project, row);
    return match ? adopt(cfg, row, match, links) : null;
  };

  // linkExisting: adopt one specific issue of the filter's result, re-checked here because the form may be stale.
  const adoptChosen = async (cfg: Cfg, project: any, row: any, key: string) => {
    if (!hasFilter(project)) throw conflict('The project has no Jira filter or label, so there is nothing to link to');
    const { found, links } = await runFilter(cfg, effectiveJql(project.jira_jql, project.jira_label));
    const chosen = found.find((j) => j.key.toUpperCase() === key.toUpperCase());
    if (!chosen) throw conflict(`${key} is not in the project's Jira filter`);
    if (takenKeys().has(chosen.key)) throw conflict(`${chosen.key} is already linked to another issue`);
    if (mapType(String(chosen.fields.issuetype?.name ?? '')) !== row.type) throw bad(`${chosen.key} is not of the same type as this issue`);
    return adopt(cfg, row, chosen, links);
  };

  // Everything both upload endpoints check before touching Jira, in order: the gate, already linked, parent uploaded, Jira project.
  // `previewOnly` lets a root issue with no Jira project yet through (target null) so the form can ask for one.
  const preflight = (req: any, requestedProject?: string, previewOnly = false) => {
    const { row, project } = load(id(req.params.id));
    const { cfg } = jiraWriteGate(project);
    const parent = row.parent_id == null ? null : (db.prepare('SELECT type, jira_key FROM issues WHERE id = ? AND project_id = ?').get(row.parent_id, P()) as { type: LocalType; jira_key: string | null });
    if (row.jira_key) throw conflict(`This issue is already linked to Jira (${row.jira_key}); use update`);
    if (parent && !parent.jira_key) throw conflict('Upload the parent issue to Jira first');
    return { row, project, cfg, parent, ...resolveTarget(project, parent, requestedProject, previewOnly) };
  };

  // The Jira project to create in: the parent's (its key minus the issue number, locked), else the requested one, else the one configured on the pjPlanner project.
  const resolveTarget = (project: any, parent: { jira_key: string | null } | null, requested: string | undefined, previewOnly: boolean) => {
    if (parent?.jira_key) return { target: { key: parent.jira_key.replace(/-\d+$/, '') } as Target, locked: true };
    const ref = requested ?? project.jira_project_id;
    if (!ref) {
      if (previewOnly) return { target: null as Target | null, locked: false };
      throw conflict('No Jira project id or key: set it in the project\'s Jira integration settings');
    }
    return { target: jiraProjectRef(ref) as Target | null, locked: false };
  };

  // What both endpoints need from Jira: the project with its issue types, the chosen issue type and (when asked) the Epic Link/Name ids.
  const loadJiraContext = async (cfg: Cfg, ctx: { row: any; parent: { type: LocalType } | null; target: Target }, wantedType: string | undefined, needFields: boolean, shared?: Promise<JiraField[]>) => {
    const ref = targetRef(ctx.target);
    const [jp, fieldList] = await Promise.all([jiraProject(cfg, ref), needFields ? (shared ?? jiraFields(cfg)) : Promise.resolve(null)]);
    const type = resolveIssueType(jp.issueTypes, wantedType ?? jiraTypeName(ctx.row.type), ref);
    return { jp, ref, type, links: fieldList ? linkFields(fieldList) : undefined };
  };

  const createFields = async (cfg: Cfg, jp: JiraProject, typeId: string, links?: LinkFields) => {
    const meta = await jiraCreateMeta(cfg, jp.key || jp.id, typeId);
    return { fields: normaliseFields(meta.fields, links ? [links.epicLink, links.epicName, links.parentLink] : []), readable: meta.readable };
  };

  // The instance's link types; null when Jira will not say (the caller decides whether that blocks).
  const linkTypesOrNull = async (cfg: Cfg): Promise<JiraLinkType[] | null> => {
    try { return await jiraLinkTypes(cfg); } catch (e) {
      if (e instanceof JiraError) return null;
      throw e;
    }
  };

  const linkInfo = async (cfg: Cfg | null, parent: { type: LocalType; jira_key: string | null } | null) => {
    if (!parent?.jira_key) return { kind: 'none' as const, label: 'No parent' };
    if (parent.type === 'epic') return { kind: 'epic' as const, parentKey: parent.jira_key, label: `In epic ${parent.jira_key}` };
    const linkTypes = cfg ? ((await linkTypesOrNull(cfg)) ?? []) : [];
    return { kind: 'link' as const, parentKey: parent.jira_key, label: `Linked to ${parent.jira_key}`, linkTypes, linkType: defaultLinkType(linkTypes)?.name ?? null };
  };

  // Previews an upload: the Jira project, its issue types, the values that would be sent and the extra fields Jira offers. Creates nothing.
  app.get('/api/issues/:id/jira/upload-form', async (req) => {
    const q = req.query as { jiraProject?: string; issueType?: string };
    const ctx = preflight(req, q.jiraProject ? parseJiraProjectId(q.jiraProject) : undefined, true);
    const { row, project, cfg, parent } = ctx;
    const values = { title: row.title, description: row.description ?? '', labels: project.jira_label ? [project.jira_label] : [] };
    // A root issue with no Jira project known yet: the form asks for one and reloads with it.
    if (!ctx.target) return { project: { ref: null, locked: false }, issueTypes: [], issueType: null, values, link: await linkInfo(null, parent), match: null, fields: [] };
    const target = ctx.target;
    return viaJira(async () => {
      // One /field read serves both the link-field ids and the filter lookup.
      const shared = jiraFields(cfg);
      shared.catch(() => undefined);
      const [jc, match] = await Promise.all([
        loadJiraContext(cfg, { ...ctx, target }, q.issueType?.trim() || undefined, true, shared),
        hasFilter(project) ? shared.then((fl) => filterMatch(cfg, project, row, fl)).then((m) => m.match).catch(() => null) : Promise.resolve(null),
      ]);
      const { fields, readable } = await createFields(cfg, jc.jp, jc.type.id, jc.links);
      return {
        project: { ref: jc.ref, key: jc.jp.key, id: jc.jp.id, name: jc.jp.name, locked: ctx.locked },
        issueTypes: jc.jp.issueTypes, issueType: { id: jc.type.id, name: jc.type.name },
        values,
        link: await linkInfo(cfg, parent),
        match: match ? { key: match.key, url: browseUrl(cfg, match.key), title: String(match.fields.summary ?? '') } : null,
        fields: applyUploadConfig(fields, readUploadConfig(project.jira_upload_config)),
        ...(readable ? {} : { fieldsUnavailable: true }),
      };
    });
  });

  // The fields Jira offers when creating an issue of a type in a Jira project, for the integration settings. Reads only: needs Jira enabled, not the write switch.
  app.get('/api/jira/create-fields', async (req) => {
    const q = req.query as { jiraProject?: string; issueType?: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(P()) as any;
    jiraEnabledGate(project);
    const cfg = jira();
    const requested = q.jiraProject?.trim() ? parseJiraProjectId(q.jiraProject) : undefined;
    const ref = requested ?? project.jira_project_id;
    if (!ref) return { project: { ref: null }, issueTypes: [], issueType: null, fields: [] };
    const target = jiraProjectRef(ref) as Target;
    return viaJira(async () => {
      const wanted = q.issueType?.trim() || undefined;
      const [jp, fieldList] = await Promise.all([jiraProject(cfg, targetRef(target)), jiraFields(cfg)]);
      const type = wanted ? resolveIssueType(jp.issueTypes, wanted, targetRef(target)) : (jp.issueTypes.find((t) => !t.subtask) ?? jp.issueTypes[0]);
      if (!type) return { project: { ref: targetRef(target), key: jp.key, id: jp.id, name: jp.name }, issueTypes: [], issueType: null, fields: [] };
      const links = linkFields(fieldList);
      const { fields, readable } = await createFields(cfg, jp, type.id, links);
      return {
        project: { ref: targetRef(target), key: jp.key, id: jp.id, name: jp.name },
        issueTypes: jp.issueTypes, issueType: { id: type.id, name: type.name },
        fields,
        ...(readable ? {} : { fieldsUnavailable: true }),
      };
    });
  });

  // Issues with an upload in flight: the "already linked" check in preflight only sees the key once the Jira call finished,
  // so a double click or agent retry would otherwise create the issue twice.
  const uploading = new Set<number>();

  app.post('/api/issues/:id/jira/upload', async (req) => {
    const form = parseUploadBody(req.body);
    const ctx = preflight(req, form.projectRef);
    const { row, project, cfg, parent } = ctx;
    const target = ctx.target!; // only the preview may lack a target
    const type = row.type as LocalType;
    if (uploading.has(row.id)) throw conflict('An upload of this issue is already running');
    uploading.add(row.id);

    return viaJira(async () => {
      if (form.linkExisting) {
        const adopted = await adoptChosen(cfg, project, row, form.linkExisting);
        return { issue: getIssue(row.id), adopted: true, url: browseUrl(cfg, adopted.key) };
      }
      if (!form.explicit && hasFilter(project)) {
        const adopted = await tryAdopt(cfg, project, row);
        if (adopted) return { issue: getIssue(row.id), adopted: true, url: browseUrl(cfg, adopted.key) };
      }
      // A task under a story or bug is linked to it after creation; the link type is settled before anything is created.
      const linkParent = parent?.jira_key && parent.type !== 'epic' ? parent.jira_key : null;
      let linkType: string | null = null;
      let linkWarning: string | undefined;
      if (linkParent) {
        const types = await linkTypesOrNull(cfg);
        if (form.linkType) {
          const chosen = types?.find((t) => t.name.toLowerCase() === form.linkType!.toLowerCase());
          if (!chosen) throw bad(`Jira has no link type '${form.linkType}'`);
          linkType = chosen.name;
        } else {
          linkType = types ? (defaultLinkType(types)?.name ?? null) : null;
          if (!linkType) linkWarning = `Created, but could not link it to ${linkParent}: Jira offers no link type`;
        }
      }
      const needLinks = type === 'epic' || parent?.type === 'epic';
      // A bare upload (agent/MCP) still reads createmeta when the project config hides a field that has a default, so the default is sent.
      const uploadConfig = readUploadConfig(project.jira_upload_config);
      const readFields = form.explicit || uploadConfig.hidden.some((h) => uploadConfig.defaults[h] !== undefined);
      const jc = await loadJiraContext(cfg, { ...ctx, target }, form.issueType, needLinks || readFields);
      const title = form.title ?? row.title;
      const description = form.description ?? row.description ?? '';
      let extra: Record<string, unknown> | undefined;
      if (readFields) {
        const cf = await createFields(cfg, jc.jp, jc.type.id, jc.links);
        extra = validateFields(cf.fields, withHiddenDefaults(cf.fields, uploadConfig, form.fields ?? {}), cf.readable);
      }
      const { fields } = buildCreatePayload({
        project: target, type, title, description, label: project.jira_label, labels: form.labels, extra,
        parentType: parent?.type ?? null, parentKey: parent?.jira_key ?? null, links: jc.links,
      });
      fields.issuetype = { name: jc.type.name };
      const created = await jiraPost<{ key: string }>(cfg, '/rest/api/2/issue', { fields });
      const syncedAt = await fetchUpdated(cfg, created.key);
      try {
        db.prepare('UPDATE issues SET jira_key = ?, jira_synced_at = ?, title = ?, description = ? WHERE id = ?').run(created.key, syncedAt, title, form.description ?? row.description, row.id);
      } catch (e: any) {
        throw new HttpError(500, 'internal_error', `Created ${created.key} in Jira but could not save the key locally: ${e?.message ?? e}`);
      }
      if (linkParent && linkType) {
        try {
          await jiraPost(cfg, '/rest/api/2/issueLink', { type: { name: linkType }, inwardIssue: { key: created.key }, outwardIssue: { key: linkParent } });
        } catch (e: any) {
          linkWarning = `Created ${created.key}, but could not link it to ${linkParent}: ${e?.message ?? e}`;
        }
        // Linking bumps the new issue's `updated`; read it again so the first update is not a false conflict.
        const afterLink = await fetchUpdated(cfg, created.key);
        if (afterLink) db.prepare('UPDATE issues SET jira_synced_at = ? WHERE id = ?').run(afterLink, row.id);
      }
      return { issue: getIssue(row.id), adopted: false, url: browseUrl(cfg, created.key), ...(linkWarning ? { linkWarning } : {}) };
    }).finally(() => { uploading.delete(row.id); });
  });

  app.post('/api/issues/:id/jira/update', async (req) => {
    const b: Body = req.body == null ? {} : obj(req.body);
    const force = b.force === true;
    const { row, project } = load(id((req.params as any).id));
    const { cfg } = jiraWriteGate(project);
    if (!row.jira_key) throw conflict('This issue is not linked to Jira; upload it first');
    return viaJira(async () => {
      const path = `/rest/api/2/issue/${encodeURIComponent(row.jira_key)}`;
      const cur = await jiraGet<{ fields: { updated?: string; labels?: string[] } }>(cfg, `${path}?fields=updated,labels`);
      const updated = cur.fields.updated ? parseTime(cur.fields.updated) : NaN;
      // The issue's own sync time when it has one (imports, uploads, updates and refreshes all set it); the project's only as a fallback.
      const known = [row.jira_synced_at, project.jira_synced_at].map((t) => (t ? parseTime(t) : NaN)).find(Number.isFinite) ?? NaN;
      // Fail closed: an unreadable `updated` or an unknown sync time counts as a conflict.
      if (!force && (Number.isNaN(updated) || Number.isNaN(known) || updated > known)) {
        throw conflict('Jira changed since the last import (or it cannot be told); import first or force the update', { jiraUpdated: true, jiraUpdatedAt: Number.isNaN(updated) ? null : new Date(updated).toISOString() });
      }
      await jiraPut(cfg, path, buildUpdatePayload({ title: row.title, description: row.description ?? '', label: project.jira_label, currentLabels: cur.fields.labels ?? [] }));
      const after = await fetchUpdated(cfg, row.jira_key);
      db.prepare('UPDATE issues SET jira_synced_at = ? WHERE id = ?').run(after, row.id);
      return { issue: getIssue(row.id), url: browseUrl(cfg, row.jira_key) };
    });
  });

  // Pulls title, description and state of the linked Jira issue over the local one. Reads only: needs Jira enabled, not JIRA_WRITE.
  app.post('/api/issues/:id/jira/refresh', async (req) => {
    const { row, project } = load(id((req.params as any).id));
    jiraEnabledGate(project);
    const cfg = jira();
    if (!row.jira_key) throw conflict('This issue is not linked to Jira');
    return viaJira(async () => {
      let j: JiraIssue;
      try {
        j = await jiraGet<JiraIssue>(cfg, `/rest/api/2/issue/${encodeURIComponent(row.jira_key)}?fields=summary,description,status,updated`);
      } catch (e: any) {
        if (e?.status === 404) throw new HttpError(404, 'not_found', 'Not found in Jira');
        throw e;
      }
      const title = String(j.fields.summary ?? '').trim() || row.jira_key;
      const description = stripFootnote(typeof j.fields.description === 'string' ? j.fields.description : '');
      const state = mapState(String(j.fields.status?.name ?? ''), j.fields.status?.statusCategory?.key);
      const updated = typeof j.fields.updated === 'string' ? j.fields.updated : null;
      const tm = jiraTiming(row, state);
      db.prepare('UPDATE issues SET title = ?, description = ?, state = ?, closed_at = ?, closed_owner_id = ?, reopen_count = ?, updated_at = ?, jira_synced_at = ? WHERE id = ?')
        .run(title, description, state, tm.closedAt, tm.closedOwner, tm.reopens, tm.now, updated, row.id);
      return { issue: getIssue(row.id) };
    });
  });
}
