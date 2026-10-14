import type { JiraCreateFields, JiraImportResult, JiraUploadConfig, JiraInfo, JiraPreview, JiraStatus, JiraUploadBody, JiraUploadForm, JiraWriteResult, Project, Sprint, SprintInput, Issue, IssueInput, Graph, Group, GroupInput, OwnerInput, Module, ModuleInput, Owner, Relation } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

// The active project travels as an x-project header; without it the server uses its oldest project.
const PROJECT_KEY = 'pjplanner.project';
let currentProject: number | null = (() => {
  try { const v = Number(localStorage.getItem(PROJECT_KEY)); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
})();
export const getProjectId = () => currentProject;
export function setProjectId(id: number | null) {
  currentProject = id;
  try { if (id === null) localStorage.removeItem(PROJECT_KEY); else localStorage.setItem(PROJECT_KEY, String(id)); } catch { /* storage unavailable */ }
}

// The write key unlocks editing: the server rejects every write without it. Kept in this browser only.
const KEY_KEY = 'pjplanner.key';
let writeKey: string = (() => { try { return localStorage.getItem(KEY_KEY) ?? ''; } catch { return ''; } })();
export const getWriteKey = () => writeKey;
export function setWriteKey(k: string) {
  writeKey = k;
  try { if (k) localStorage.setItem(KEY_KEY, k); else localStorage.removeItem(KEY_KEY); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('pjplanner:key'));
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(writeKey ? { 'x-api-key': writeKey } : {}),
      ...(currentProject !== null ? { 'x-project': String(currentProject) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('pjplanner:locked')); // lets the header offer the unlock dialog
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `Request failed (${res.status})`, data?.error?.extra);
  }
  return data as T;
}

export const api = {
  access: () => request<{ locked: boolean }>('GET', '/access'),
  unlock: () => request<{ ok: boolean }>('POST', '/unlock', {}),
  listProjects: () => request<Project[]>('GET', '/projects'),
  createProject: (p: { name: string; description?: string }) => request<Project>('POST', '/projects', p),
  updateProject: (id: number, p: { name: string; description?: string; jiraJql?: string | null; jiraLabel?: string | null; jiraWrite?: boolean; jiraEnabled?: boolean; jiraProjectId?: string | null; jiraUploadConfig?: JiraUploadConfig | null }) => request<Project>('PUT', `/projects/${id}`, p),
  deleteProject: (id: number) => request<void>('DELETE', `/projects/${id}`),
  importProject: (file: unknown) => request<Project>('POST', '/projects/import', file),
  jiraStatus: () => request<JiraStatus>('GET', '/jira/status'),
  jiraUploadForm: (issueId: number, q: { jiraProject?: string; issueType?: string } = {}) => {
    const qs = new URLSearchParams();
    if (q.jiraProject) qs.set('jiraProject', q.jiraProject);
    if (q.issueType) qs.set('issueType', q.issueType);
    return request<JiraUploadForm>('GET', `/issues/${issueId}/jira/upload-form${qs.size ? `?${qs}` : ''}`);
  },
  jiraCreateFields: (q: { jiraProject?: string; issueType?: string } = {}) => {
    const qs = new URLSearchParams();
    if (q.jiraProject) qs.set('jiraProject', q.jiraProject);
    if (q.issueType) qs.set('issueType', q.issueType);
    return request<JiraCreateFields>('GET', `/jira/create-fields${qs.size ? `?${qs}` : ''}`);
  },
  jiraUpload: (issueId: number, body: JiraUploadBody = {}) => request<JiraWriteResult>('POST', `/issues/${issueId}/jira/upload`, body),
  jiraUpdate: (issueId: number, force = false) => request<JiraWriteResult>('POST', `/issues/${issueId}/jira/update`, force ? { force: true } : {}),
  jiraRefresh: (issueId: number) => request<{ issue: Issue }>('POST', `/issues/${issueId}/jira/refresh`, {}),
  jiraTest: () => request<JiraInfo>('POST', '/jira/test', {}),
  jiraPreview: (f: { jql?: string; label?: string }) => request<JiraPreview>('POST', '/jira/preview', f),
  jiraImport: (projectId: number) => request<JiraImportResult>('POST', `/projects/${projectId}/jira/import`, {}),
  getGraph: () => request<Graph>('GET', '/graph'),
  createModule: (m: ModuleInput) => request<Module>('POST', '/modules', m),
  updateModule: (id: number, m: ModuleInput) => request<Module>('PUT', `/modules/${id}`, m),
  setPosition: (id: number, pos: { x: number; y: number }) => request<Module>('PUT', `/modules/${id}/position`, pos),
  setPositions: (positions: { id: number; x: number; y: number }[]) => request<Module[]>('PUT', '/modules/positions', { positions }),
  deleteModule: (id: number) => request<void>('DELETE', `/modules/${id}`),
  createOwner: (o: OwnerInput) => request<Owner>('POST', '/owners', o),
  updateOwner: (id: number, o: OwnerInput) => request<Owner>('PUT', `/owners/${id}`, o),
  deleteOwner: (id: number) => request<void>('DELETE', `/owners/${id}`),
  createGroup: (g: GroupInput) => request<Group>('POST', '/groups', g),
  updateGroup: (id: number, g: GroupInput) => request<Group>('PUT', `/groups/${id}`, g),
  deleteGroup: (id: number) => request<void>('DELETE', `/groups/${id}`),
  listIssues: () => request<Issue[]>('GET', '/issues'),
  getIssue: (id: number) => request<Issue>('GET', `/issues/${id}`),
  createIssue: (i: IssueInput) => request<Issue>('POST', '/issues', i),
  updateIssue: (id: number, i: IssueInput) => request<Issue>('PUT', `/issues/${id}`, i),
  autoAssignIssue: (id: number) => request<Issue>('POST', `/issues/${id}/assign`),
  autoAssignSprint: (id: number, reset = false) => request<Sprint>('POST', `/sprints/${id}/assign${reset ? '?reset=1' : ''}`),
  deleteIssue: (id: number) => request<void>('DELETE', `/issues/${id}`),
  listSprints: () => request<Sprint[]>('GET', '/sprints'),
  createSprint: (sp: SprintInput) => request<Sprint>('POST', '/sprints', sp),
  updateSprint: (id: number, sp: SprintInput) => request<Sprint>('PUT', `/sprints/${id}`, sp),
  deleteSprint: (id: number) => request<void>('DELETE', `/sprints/${id}`),
  createRelation: (r: { sourceId: number; targetId: number; label?: string | null; color?: string | null }) => request<Relation>('POST', '/relations', r),
  updateRelation: (id: number, r: { label: string | null; color: string | null }) => request<Relation>('PUT', `/relations/${id}`, r),
  deleteRelation: (id: number) => request<void>('DELETE', `/relations/${id}`),
};
