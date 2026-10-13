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

export async function jiraGet<T>(cfg: JiraConfig, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e: any) {
    throw new JiraError(502, `Cannot reach Jira at ${cfg.url}: ${e?.cause?.code ?? e?.message ?? 'network error'}`);
  }
  if (res.status === 401 || res.status === 403) throw new JiraError(502, 'Jira rejected the token (check JIRA_TOKEN and the bot account permissions)');
  if (res.status === 404) throw new JiraError(404, 'Not found in Jira');
  if (!res.ok) throw new JiraError(502, `Jira answered ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new JiraError(502, 'Jira did not return JSON (is JIRA_URL the base address of Jira?)');
  }
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

export interface JiraDiscovery {
  project: { key: string; name: string };
  issueTypes: { id: string; name: string; subtask: boolean }[];
  epicLinkField: string | null;
  // pjPlanner issue type -> suggested Jira issue type name (null when no match)
  typeMap: Record<'epic' | 'story' | 'bug' | 'task', string | null>;
}

// Reads what a project's setup looks like so the manager can review a prefilled mapping instead of typing field ids.
export async function jiraDiscover(cfg: JiraConfig, projectKey: string): Promise<JiraDiscovery> {
  const key = encodeURIComponent(projectKey);
  const [project, fields] = await Promise.all([
    jiraGet<{ key: string; name: string; issueTypes?: { id: string; name: string; subtask?: boolean }[] }>(cfg, `/rest/api/2/project/${key}`),
    jiraGet<{ id: string; name: string; custom?: boolean }[]>(cfg, '/rest/api/2/field'),
  ]);
  const issueTypes = (project.issueTypes ?? []).map((t) => ({ id: t.id, name: t.name, subtask: Boolean(t.subtask) }));
  const find = (...names: string[]) =>
    issueTypes.find((t) => !t.subtask && names.includes(t.name.toLowerCase()))?.name ?? null;
  return {
    project: { key: project.key, name: project.name },
    issueTypes,
    epicLinkField: fields.find((f) => f.custom && f.name === 'Epic Link')?.id ?? null,
    typeMap: { epic: find('epic'), story: find('story'), bug: find('bug'), task: find('task') },
  };
}
