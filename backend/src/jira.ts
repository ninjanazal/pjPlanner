// Jira Data Center / Server client (REST API v2, Personal Access Token as Bearer). The shared bot's URL and token come from
// the environment only (JIRA_URL, JIRA_TOKEN); they never reach the database, an export or an API response.

export class JiraError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface JiraConfig { url: string; token: string }

export const jiraConfig = (): JiraConfig | null => {
  const url = (process.env.JIRA_URL ?? '').trim().replace(/\/+$/, '');
  const token = (process.env.JIRA_TOKEN ?? '').trim();
  return url && token ? { url, token } : null;
};

// A 400 from Jira carries its reasons in errorMessages (whole request) and errors (per field); both are passed on.
async function jiraRequest<T>(cfg: JiraConfig, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    throw new JiraError(502, `Cannot reach Jira at ${cfg.url}: ${e?.cause?.code ?? e?.message ?? 'network error'}`);
  }
  if (res.status === 401 || res.status === 403) throw new JiraError(502, 'Jira rejected the token (check JIRA_TOKEN and the bot account permissions)');
  if (res.status === 400) {
    const j = (await res.json().catch(() => null)) as { errorMessages?: string[]; errors?: Record<string, string> } | null;
    const msg = [...(j?.errorMessages ?? []), ...Object.entries(j?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ');
    throw new JiraError(400, msg || 'Jira rejected the request');
  }
  if (res.status === 404) throw new JiraError(404, 'Not found in Jira');
  if (res.status === 405) throw new JiraError(405, 'Jira answered 405');
  if (!res.ok) throw new JiraError(502, `Jira answered ${res.status}`);
  if (res.status === 204) return undefined as T;
  try {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    throw new JiraError(502, 'Jira did not return JSON (is JIRA_URL the base address of Jira?)');
  }
}

export const jiraGet = <T>(cfg: JiraConfig, path: string): Promise<T> => jiraRequest<T>(cfg, 'GET', path);
export const jiraPost = <T>(cfg: JiraConfig, path: string, body: unknown): Promise<T> => jiraRequest<T>(cfg, 'POST', path, body);
export const jiraPut = <T>(cfg: JiraConfig, path: string, body: unknown): Promise<T> => jiraRequest<T>(cfg, 'PUT', path, body);

// Writing to Jira needs three things: the project's Jira integration enabled, JIRA_WRITE=1 here, and the per-project jira_write flag.
export const writeEnv = () => ({
  enabled: ['1', 'true'].includes((process.env.JIRA_WRITE ?? '').trim().toLowerCase()),
});

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  issueTypes: { id: string; name: string; subtask: boolean }[];
}

// A Jira project (by key or id) with the issue types it accepts.
export async function jiraProject(cfg: JiraConfig, keyOrId: string): Promise<JiraProject> {
  const p = await jiraGet<{ id?: string; key?: string; name?: string; issueTypes?: { id: string; name: string; subtask?: boolean }[] }>(cfg, `/rest/api/2/project/${encodeURIComponent(keyOrId)}`);
  return {
    id: String(p.id ?? ''), key: String(p.key ?? ''), name: String(p.name ?? ''),
    issueTypes: (p.issueTypes ?? []).map((t) => ({ id: String(t.id), name: t.name, subtask: Boolean(t.subtask) })),
  };
}

// The raw fields Jira offers when creating an issue of a type in a project. Data Center 8.4+ pages through
// issue/createmeta/{project}/issuetypes/{type}; older servers (and Cloud-style 404/405) only have the expanded issue/createmeta.
// Which one answers is detected from the response. Unreadable metadata (no permission, error) yields no fields and `readable: false` so creating still works.
export async function jiraCreateMeta(cfg: JiraConfig, projectRef: string, typeId: string): Promise<{ fields: any[]; readable: boolean }> {
  try {
    const paged = await createMetaPaged(cfg, projectRef, typeId);
    return { fields: paged ?? (await createMetaExpanded(cfg, projectRef, typeId)), readable: true };
  } catch (e) {
    if (e instanceof JiraError) return { fields: [], readable: false };
    throw e;
  }
}

async function createMetaPaged(cfg: JiraConfig, projectRef: string, typeId: string): Promise<any[] | null> {
  const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(projectRef)}/issuetypes/${encodeURIComponent(typeId)}`;
  const out: any[] = [];
  for (;;) {
    let page: { values?: any[]; total?: number; isLast?: boolean };
    try {
      page = await jiraGet(cfg, `${base}?startAt=${out.length}&maxResults=50`);
    } catch (e) {
      if (e instanceof JiraError && (e.status === 404 || e.status === 405) && out.length === 0) return null;
      throw e;
    }
    if (!Array.isArray(page.values)) return out.length ? out : null;
    out.push(...page.values);
    if (page.values.length === 0 || page.isLast || (typeof page.total === 'number' && out.length >= page.total) || (page.isLast === undefined && page.total === undefined)) return out;
  }
}

async function createMetaExpanded(cfg: JiraConfig, projectRef: string, typeId: string): Promise<any[]> {
  const qs = new URLSearchParams({ projectKeys: projectRef, issuetypeIds: typeId, expand: 'projects.issuetypes.fields' });
  const r = await jiraGet<{ projects?: { issuetypes?: { fields?: Record<string, any> }[] }[] }>(cfg, `/rest/api/2/issue/createmeta?${qs}`);
  const fields = r.projects?.[0]?.issuetypes?.[0]?.fields ?? {};
  return Object.entries(fields).map(([id, f]) => ({ ...f, fieldId: f?.fieldId ?? id }));
}

export interface JiraInfo {
  version: string;
  deploymentType: string;
  user: { name: string; displayName: string };
}

// Checks the URL and token: serverInfo for version/deployment, myself for the bot account the token belongs to.
export async function jiraTest(cfg: JiraConfig): Promise<JiraInfo> {
  const [info, me] = await Promise.all([
    jiraGet<{ version: string; deploymentType?: string }>(cfg, '/rest/api/2/serverInfo'),
    jiraGet<{ name?: string; key?: string; displayName: string }>(cfg, '/rest/api/2/myself'),
  ]);
  return {
    version: info.version,
    deploymentType: info.deploymentType ?? 'Server',
    user: { name: me.name ?? me.key ?? '', displayName: me.displayName },
  };
}

export interface JiraField { id: string; name: string; custom: boolean }

export async function jiraFields(cfg: JiraConfig): Promise<JiraField[]> {
  const rows = await jiraGet<{ id: string; name: string; custom?: boolean }[]>(cfg, '/rest/api/2/field');
  return rows.map((f) => ({ id: f.id, name: f.name, custom: Boolean(f.custom) }));
}

export interface JiraLinkType { id: string; name: string; inward: string; outward: string }

export async function jiraLinkTypes(cfg: JiraConfig): Promise<JiraLinkType[]> {
  const r = await jiraGet<{ issueLinkTypes?: { id: string; name: string; inward?: string; outward?: string }[] }>(cfg, '/rest/api/2/issueLinkType');
  return (r.issueLinkTypes ?? []).map((t) => ({ id: String(t.id), name: t.name, inward: t.inward ?? '', outward: t.outward ?? '' }));
}

export interface JiraIssue { key: string; fields: Record<string, any> }

// Runs a JQL search page by page. `total` is what Jira matched; only the first `max` issues are fetched.
export async function jiraSearch(cfg: JiraConfig, jql: string, fields: string[], max: number): Promise<{ total: number; issues: JiraIssue[] }> {
  const issues: JiraIssue[] = [];
  let total = 0;
  while (issues.length < max) {
    const qs = new URLSearchParams({ jql, fields: fields.join(','), startAt: String(issues.length), maxResults: String(Math.min(100, max - issues.length)) });
    const page = await jiraGet<{ total: number; issues: JiraIssue[] }>(cfg, `/rest/api/2/search?${qs}`);
    total = page.total;
    issues.push(...page.issues);
    if (page.issues.length === 0 || issues.length >= total) break;
  }
  return { total, issues };
}
