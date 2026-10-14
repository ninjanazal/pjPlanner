import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { addFootnote, stripFootnote } from '../src/jiraSync.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let app: ReturnType<typeof buildApp>;
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ENV = ['JIRA_URL', 'JIRA_TOKEN', 'JIRA_WRITE', 'WRITE_KEY'];

const FIELDS = [
  { id: 'customfield_10301', name: 'Epic Link', custom: true },
  { id: 'customfield_10302', name: 'Epic Name', custom: true },
];
interface Stub {
  issues: any[]; types: string[]; fields: any[];
  existing: any | null; // answer to GET /issue/KEY (null = 404)
  createFail: boolean; putFail: boolean;
  meta: any[]; // raw createmeta fields
  metaMode: 'paged' | 'old404' | 'old405' | 'none'; // none = createmeta answers 403 everywhere
  metaPageSize: number; searchFail: boolean;
  bumpOnPut: boolean; // a PUT moves existing.fields.updated to a few seconds in the future, like Jira does
  failUpdatedRead: boolean; // GET ...?fields=updated (the read after a write) answers 404
  linkTypes: { id: string; name: string; inward: string; outward: string }[]; linkFail: boolean; linkTypesFail: boolean;
  calls: { method: string; url: string; body: any }[];
}
let st: Stub;
const stub = (over: Partial<Stub> = {}) => {
  let n = 0;
  st = { issues: [], types: ['Epic', 'Story', 'Bug', 'Task', 'Sub-task'], fields: FIELDS, existing: { fields: { updated: '2020-01-01T00:00:00.000+0000', labels: [] } }, createFail: false, putFail: false, meta: [], metaMode: 'paged', metaPageSize: 50, searchFail: false, bumpOnPut: true, failUpdatedRead: false, linkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' }], linkFail: false, linkTypesFail: false, calls: [], ...over };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const method = init.method ?? 'GET';
    st.calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/rest/api/2/field')) return respond(st.fields);
    if (url.endsWith('/rest/api/2/issueLinkType')) return st.linkTypesFail ? respond({}, 500) : respond({ issueLinkTypes: st.linkTypes });
    if (method === 'POST' && url.endsWith('/rest/api/2/issueLink')) return st.linkFail ? respond({ errorMessages: ['no permission to link'] }, 400) : new Response(null, { status: 201 });
    if (url.includes('/rest/api/2/issue/createmeta')) {
      if (st.metaMode === 'none') return respond({}, 403);
      if (url.includes('/issuetypes/')) {
        if (st.metaMode !== 'paged') return respond({}, st.metaMode === 'old404' ? 404 : 405);
        const u = new URL(url); const start = Number(u.searchParams.get('startAt')); const size = Math.min(st.metaPageSize, Number(u.searchParams.get('maxResults')));
        const values = st.meta.slice(start, start + size);
        return respond({ startAt: start, maxResults: size, total: st.meta.length, isLast: start + size >= st.meta.length, values });
      }
      return respond({ projects: [{ issuetypes: [{ fields: Object.fromEntries(st.meta.map((f) => [f.fieldId, { ...f, fieldId: undefined }])) }] }] });
    }
    if (st.searchFail && url.includes('/rest/api/2/search')) return respond({}, 500);
    if (url.includes('/rest/api/2/search')) return respond({ total: st.issues.length, issues: st.issues });
    if (url.includes('/rest/api/2/project/')) {
      const ref = decodeURIComponent(url.split('/project/')[1]); const numeric = /^\d+$/.test(ref);
      return respond({ id: numeric ? ref : '10000', key: numeric ? 'KEY' : ref, name: 'Key Project', issueTypes: st.types.map((name, i) => ({ id: String(i + 1), name, subtask: /sub/i.test(name) })) });
    }
    if (method === 'POST' && url.endsWith('/rest/api/2/issue')) {
      if (st.createFail) return respond({ errors: { summary: 'bad summary' } }, 400);
      return respond({ key: `KEY-${100 + n++}` });
    }
    if (method === 'PUT') {
      if (st.putFail) return respond({ errorMessages: ['nope'] }, 400);
      if (st.bumpOnPut && st.existing) st.existing = { fields: { ...st.existing.fields, updated: new Date(Date.now() + 5000).toISOString().replace('Z', '+0000') } };
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && st.failUpdatedRead && url.endsWith('?fields=updated')) return respond({}, 404);
    if (method === 'GET' && url.includes('/rest/api/2/issue/')) return st.existing ? respond(st.existing) : respond({}, 404);
    return respond({}, 404);
  }));
};
const writes = () => st.calls.filter((c) => c.method !== 'GET');
const linkCalls = () => st.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rest/api/2/issueLink'));
const creates = () => st.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rest/api/2/issue'));

const env = (o: Record<string, string> = {}) => {
  Object.assign(process.env, { JIRA_URL: 'https://jira.local', JIRA_TOKEN: 't', JIRA_WRITE: '1', ...o });
};
const api = async (method: any, url: string, payload?: any, headers?: any) => {
  const r = await app.inject({ method, url, payload, headers });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeEach(() => { app = buildApp(':memory:'); mods.clear(); });
afterEach(() => { vi.unstubAllGlobals(); for (const k of ENV) delete process.env[k]; });

let pn = 0;
const project = async (o: any = {}) => (await api('POST', '/api/projects', { name: `P${pn++}`, jiraWrite: true, jiraEnabled: true, jiraProjectId: '10000', ...o })).body;
const mods = new Map<number, number>();
const mk = async (pid: number, type: string, title: string, parentId?: number) => {
  if (type === 'task' && !mods.has(pid)) mods.set(pid, (await api('POST', `/api/modules?project=${pid}`, { name: 'M' })).body.id);
  return (await api('POST', `/api/issues?project=${pid}`, { type, title, description: `${title} desc`, ...(type === 'task' ? { moduleId: mods.get(pid) } : {}), ...(parentId ? { parentId } : {}) })).body;
};
const upload = (pid: number, iid: number, headers?: any) => api('POST', `/api/issues/${iid}/jira/upload?project=${pid}`, undefined, headers);
const update = (pid: number, iid: number, payload?: any, headers?: any) => api('POST', `/api/issues/${iid}/jira/update?project=${pid}`, payload, headers);
const jiraIssue = (key: string, type: string, title: string, extra: any = {}) => ({
  key, fields: { summary: title, description: `${key} jira desc`, issuetype: { name: type }, status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, ...extra },
});

describe('write gate (AC1)', () => {
  const expect409 = async (pid: number, iid: number, msg: RegExp) => {
    for (const r of [await upload(pid, iid), await update(pid, iid)]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('conflict');
      expect(r.body.error.message).toMatch(msg);
    }
    expect(st.calls).toHaveLength(0);
  };

  it('refuses when JIRA_WRITE is off', async () => {
    env({ JIRA_WRITE: '0' }); stub();
    const p = await project(); const i = await mk(p.id, 'epic', 'E');
    await expect409(p.id, i.id, /JIRA_WRITE/);
  });

  it('refuses a root issue when the project has no Jira project id', async () => {
    env(); stub();
    const p = await project({ jiraProjectId: undefined }); const i = await mk(p.id, 'epic', 'E');
    const r = await upload(p.id, i.id);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/project id/);
    expect(st.calls).toHaveLength(0);
  });

  it('refuses when the project toggle is off', async () => {
    env(); stub();
    const p = await project({ jiraWrite: false }); const i = await mk(p.id, 'epic', 'E');
    await expect409(p.id, i.id, /not enabled for this project/);
  });

  it('refuses when Jira itself is not configured', async () => {
    env(); delete process.env.JIRA_URL; stub();
    const p = await project(); const i = await mk(p.id, 'epic', 'E');
    expect((await upload(p.id, i.id)).status).toBe(409);
    expect(st.calls).toHaveLength(0);
  });

  it('status exposes writeAllowed and no project key', async () => {
    env(); stub();
    expect((await api('GET', '/api/jira/status')).body).toMatchObject({ configured: true, writeAllowed: true });
    expect((await api('GET', '/api/jira/status')).body).not.toHaveProperty('projectKey');
    process.env.JIRA_WRITE = '';
    expect((await api('GET', '/api/jira/status')).body.writeAllowed).toBe(false);
  });

  it('the project toggle round-trips through the project payload', async () => {
    const p = await project();
    expect(p.jiraWrite).toBe(true);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name })).body.jiraWrite).toBe(true);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraWrite: false })).body.jiraWrite).toBe(false);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraWrite: 'yes' })).status).toBe(400);
  });

  it('an exported then imported project always has writing off', async () => {
    const p = await project();
    const file = (await api('GET', `/api/projects/${p.id}/export`)).body;
    expect(JSON.stringify(file)).not.toMatch(/jiraWrite|jira_write/);
    const q = (await api('POST', '/api/projects/import', { ...file, jiraWrite: true, project: { ...file.project, jiraWrite: true } })).body;
    expect(q.jiraWrite).toBe(false);
  });
});

describe('jiraProjectId', () => {
  it('validates and round-trips; omitted keeps, null clears', async () => {
    const p = await project();
    expect(p.jiraProjectId).toBe('10000');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name })).body.jiraProjectId).toBe('10000');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraProjectId: ' 10050 ' })).body.jiraProjectId).toBe('10050');
    for (const bad of ['', '   ', 'a b', 'x'.repeat(51), 5]) expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraProjectId: bad })).status).toBe(400);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraProjectId: null })).body.jiraProjectId).toBeNull();
  });

  it('is not exported or imported', async () => {
    const p = await project();
    const file = (await api('GET', `/api/projects/${p.id}/export`)).body;
    expect(JSON.stringify(file)).not.toMatch(/jiraProjectId|jira_project_id/);
    const q = (await api('POST', '/api/projects/import', { ...file, project: { ...file.project, jiraProjectId: '999' } })).body;
    expect(q.jiraProjectId).toBeNull();
  });

  it('a child is created in its parent\'s Jira project and linked; a root uses the configured id', async () => {
    env(); stub();
    const p = await project();
    const e = await mk(p.id, 'epic', 'E'); await upload(p.id, e.id);
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraProjectId: '777' });
    const s = await mk(p.id, 'story', 'S', e.id);
    // the parent's key decides the project, not the configured id
    st.calls.length = 0;
    const r = await upload(p.id, s.id);
    expect(r.status).toBe(200);
    expect(creates()[0].body.fields).toMatchObject({ project: { key: 'KEY' }, customfield_10301: 'KEY-100' });
    expect(st.calls.some((c) => c.url.endsWith('/rest/api/2/project/KEY'))).toBe(true);
    const e2 = await mk(p.id, 'epic', 'E2');
    st.calls.length = 0;
    await upload(p.id, e2.id);
    expect(creates()[0].body.fields.project).toEqual({ id: '777' });
    expect(st.calls.some((c) => c.url.endsWith('/rest/api/2/project/777'))).toBe(true);
  });

  it('a root uses project.id for a numeric value and project.key otherwise', async () => {
    env(); stub();
    const p = await project({ jiraProjectId: '10000' });
    await upload(p.id, (await mk(p.id, 'epic', 'N')).id);
    expect(creates()[0].body.fields.project).toEqual({ id: '10000' });
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraProjectId: 'PROJ' });
    st.calls.length = 0;
    const r = await upload(p.id, (await mk(p.id, 'epic', 'K')).id);
    expect(r.status).toBe(200);
    expect(creates()[0].body.fields.project).toEqual({ key: 'PROJ' });
    expect(st.calls.some((c) => c.url.endsWith('/rest/api/2/project/PROJ'))).toBe(true);
  });
});

describe('pjPlanner footnote', () => {
  it('adds the italic footnote once and strips it', () => {
    expect(addFootnote('Body')).toBe('Body\n\n_Updated from pjPlanner_');
    expect(addFootnote(addFootnote('Body'))).toBe('Body\n\n_Updated from pjPlanner_');
    expect(addFootnote('Body\n\n')).toBe('Body\n\n_Updated from pjPlanner_');
    expect(addFootnote('')).toBe('_Updated from pjPlanner_');
    expect(stripFootnote('Body\n\n_Updated from pjPlanner_')).toBe('Body');
    expect(stripFootnote('_Updated from pjPlanner_')).toBe('');
    expect(stripFootnote('Body')).toBe('Body');
    expect(stripFootnote('_Updated from pjPlanner_ then more')).toBe('_Updated from pjPlanner_ then more');
  });

  it('sends it on create (empty description: footnote alone) and update without duplicating', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'story', 'S');
    await api('PUT', `/api/issues/${t.id}?project=${p.id}`, { type: 'story', title: 'S', description: '', state: 'open' });
    await upload(p.id, t.id);
    expect(creates()[0].body.fields.description).toBe('_Updated from pjPlanner_');
    const local = (await api('GET', `/api/issues/${t.id}?project=${p.id}`)).body;
    expect(local.description).toBe('');
  });

  it('strips it when refreshing and does not push it twice', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'story', 'S');
    await upload(p.id, t.id);
    st.existing = { key: 'KEY-100', fields: { summary: 'S', description: 'Jira body\n\n_Updated from pjPlanner_', issuetype: { name: 'Story' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, updated: '2031-01-01T00:00:00.000+0000', labels: [] } };
    const r = await api('POST', `/api/issues/${t.id}/jira/refresh?project=${p.id}`);
    expect(r.body.issue.description).toBe('Jira body');
    st.calls.length = 0;
    const u = await update(p.id, t.id);
    expect(u.status).toBe(200);
    expect(writes()[0].body.fields.description).toBe('Jira body\n\n_Updated from pjPlanner_');
  });
});

describe('upload payloads (AC2)', () => {
  beforeEach(() => { env(); stub(); });

  it('creates an epic with its Epic Name', async () => {
    const p = await project(); const e = await mk(p.id, 'epic', 'Big');
    const r = await upload(p.id, e.id);
    expect(r.status).toBe(200);
    expect(creates()[0].body).toEqual({ fields: { project: { id: '10000' }, summary: 'Big', description: 'Big desc\n\n_Updated from pjPlanner_', issuetype: { name: 'Epic' }, customfield_10302: 'Big' } });
    expect(r.body).toMatchObject({ adopted: false, url: 'https://jira.local/browse/KEY-100' });
    expect(r.body.issue.jiraKey).toBe('KEY-100');
    expect((await api('GET', `/api/issues/${e.id}?project=${p.id}`)).body.jiraKey).toBe('KEY-100');
  });

  it('story, bug and task under an uploaded epic carry Epic Link', async () => {
    const p = await project(); const e = await mk(p.id, 'epic', 'E');
    await upload(p.id, e.id);
    for (const [type, name] of [['story', 'Story'], ['bug', 'Bug'], ['task', 'Task']]) {
      const i = await mk(p.id, type, `x-${type}`, e.id);
      st.calls.length = 0;
      expect((await upload(p.id, i.id)).status).toBe(200);
      expect(creates()[0].body.fields).toMatchObject({ issuetype: { name }, customfield_10301: 'KEY-100' });
      expect(creates()[0].body.fields.parent).toBeUndefined();
    }
  });

  it('task under a story or bug is a Task linked to the parent (Relates by default), never a Sub-task', async () => {
    const p = await project();
    for (const type of ['story', 'bug']) {
      const par = await mk(p.id, type, `p-${type}`); await upload(p.id, par.id);
      const t = await mk(p.id, 'task', `t-${type}`, par.id);
      st.calls.length = 0;
      const r = await upload(p.id, t.id);
      const pk = (await api('GET', `/api/issues/${par.id}?project=${p.id}`)).body.jiraKey;
      expect(creates()[0].body.fields.issuetype).toEqual({ name: 'Task' });
      expect(creates()[0].body.fields.parent).toBeUndefined();
      expect(creates()[0].body.fields.customfield_10301).toBeUndefined();
      expect(linkCalls()).toHaveLength(1);
      expect(linkCalls()[0].body).toEqual({ type: { name: 'Relates' }, inwardIssue: { key: r.body.issue.jiraKey }, outwardIssue: { key: pk } });
      expect(r.body.linkWarning).toBeUndefined();
    }
  });

  it('linkType picks another link type (any case); an unknown one is 400 and creates nothing', async () => {
    const p = await project(); const par = await mk(p.id, 'story', 'S'); await upload(p.id, par.id);
    const t = await mk(p.id, 'task', 'T', par.id);
    st.calls.length = 0;
    const bad = await api('POST', `/api/issues/${t.id}/jira/upload?project=${p.id}`, { linkType: 'Nope' });
    expect(bad.status).toBe(400);
    expect(creates()).toHaveLength(0);
    expect((await api('GET', `/api/issues/${t.id}?project=${p.id}`)).body.jiraKey).toBeNull();
    expect((await api('POST', `/api/issues/${t.id}/jira/upload?project=${p.id}`, { linkType: 'blocks' })).status).toBe(200);
    expect(linkCalls()[0].body.type).toEqual({ name: 'Blocks' });
  });

  it('falls back to the first link type when none is named Relates', async () => {
    env(); stub({ linkTypes: [{ id: '9', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' }] });
    const p = await project(); const par = await mk(p.id, 'story', 'S'); await upload(p.id, par.id);
    const t = await mk(p.id, 'task', 'T', par.id);
    await upload(p.id, t.id);
    expect(linkCalls()[0].body.type).toEqual({ name: 'Duplicate' });
  });

  it('a failing link keeps the issue linked locally and answers with linkWarning', async () => {
    env(); stub({ linkFail: true });
    const p = await project(); const par = await mk(p.id, 'story', 'S'); await upload(p.id, par.id);
    const t = await mk(p.id, 'task', 'T', par.id);
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.issue.jiraKey).toMatch(/^KEY-/);
    expect(r.body.linkWarning).toContain('no permission to link');
  });

  it('unreadable link types: the issue is still created, with a linkWarning', async () => {
    env(); stub({ linkTypesFail: true });
    const p = await project(); const par = await mk(p.id, 'story', 'S'); await upload(p.id, par.id);
    const t = await mk(p.id, 'task', 'T', par.id);
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.linkWarning).toBeTruthy();
    expect(linkCalls()).toHaveLength(0);
  });

  it('a root story is a plain Story without links', async () => {
    const p = await project(); const t = await mk(p.id, 'story', 'Root');
    await upload(p.id, t.id);
    const f = creates()[0].body.fields;
    expect(f.issuetype).toEqual({ name: 'Story' });
    expect(f.parent).toBeUndefined(); expect(f.customfield_10301).toBeUndefined();
  });

  it('sends the label only when the project has one', async () => {
    const a = await project(); const ta = await mk(a.id, 'story', 'A');
    await upload(a.id, ta.id);
    expect(creates()[0].body.fields.labels).toBeUndefined();
    const b = await project({ jiraLabel: 'pj-track' }); const tb = await mk(b.id, 'story', 'B');
    st.calls.length = 0;
    await upload(b.id, tb.id);
    expect(creates()[0].body.fields.labels).toEqual(['pj-track']);
  });

  it('a failed read after the create still succeeds and stores the key', async () => {
    st.failUpdatedRead = true;
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.issue.jiraKey).toBe('KEY-100');
    expect((await api('GET', `/api/issues/${t.id}?project=${p.id}`)).body.jiraKey).toBe('KEY-100');
  });

  it('does not push state', async () => {
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    await upload(p.id, t.id);
    expect(JSON.stringify(creates()[0].body)).not.toMatch(/state|status/i);
  });

  it('two uploads of the same issue at once create one Jira issue; the other is a 409', async () => {
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const [a, b] = await Promise.all([upload(p.id, t.id), upload(p.id, t.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(creates()).toHaveLength(1);
    // the guard is released afterwards: the issue is linked now, so a further upload is refused for that reason instead
    const again = await upload(p.id, t.id);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already linked/);
  });

  it('a failed upload releases the guard so it can be retried', async () => {
    st.createFail = true;
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    expect((await upload(p.id, t.id)).status).toBe(400);
    st.createFail = false;
    expect((await upload(p.id, t.id)).status).toBe(200);
  });
});

describe('upload adopt (AC3)', () => {
  it('links to a Jira issue with the same type and title instead of creating', async () => {
    env(); stub({ issues: [jiraIssue('KEY-7', 'Story', '  my task ')] });
    const p = await project({ jiraLabel: 'pj-track' });
    const t = await mk(p.id, 'story', 'My Task');
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ adopted: true, url: 'https://jira.local/browse/KEY-7' });
    expect(r.body.issue).toMatchObject({ jiraKey: 'KEY-7', title: 'my task', description: 'KEY-7 jira desc', state: 'code_review' });
    expect(creates()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('does not adopt a different type, and creates instead', async () => {
    env(); stub({ issues: [jiraIssue('KEY-7', 'Task', 'Same')] });
    const p = await project({ jiraLabel: 'pj-track' });
    const t = await mk(p.id, 'story', 'Same');
    expect((await upload(p.id, t.id)).body.adopted).toBe(false);
    expect(creates()).toHaveLength(1);
  });

  it('skips the search when the project has neither JQL nor label', async () => {
    env(); stub({ issues: [jiraIssue('KEY-7', 'Story', 'Same')] });
    const p = await project();
    const t = await mk(p.id, 'story', 'Same');
    expect((await upload(p.id, t.id)).body.adopted).toBe(false);
    expect(st.calls.some((c) => c.url.includes('/search'))).toBe(false);
  });

  it('does not adopt an issue already linked to another local one', async () => {
    env(); stub({ issues: [jiraIssue('KEY-7', 'Story', 'Same')] });
    const p = await project({ jiraLabel: 'pj-track' });
    const a = await mk(p.id, 'story', 'Same'); const b = await mk(p.id, 'story', 'Same');
    expect((await upload(p.id, a.id)).body.adopted).toBe(true);
    expect((await upload(p.id, b.id)).body.adopted).toBe(false);
  });
});

describe('upload validation and failures (AC6)', () => {
  const unchanged = async (pid: number, iid: number) => expect((await api('GET', `/api/issues/${iid}?project=${pid}`)).body.jiraKey).toBeNull();

  it('400 when the Jira project lacks the issue type', async () => {
    env(); stub({ types: ['Epic', 'Story', 'Bug'] });
    const p = await project(); const par = await mk(p.id, 'story', 'S'); await upload(p.id, par.id);
    const t = await mk(p.id, 'task', 'T', par.id);
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("'Task'");
    await unchanged(p.id, t.id);
  });

  it('400 when Jira has no Epic Name or Epic Link field', async () => {
    env(); stub({ fields: [] });
    const p = await project(); const e = await mk(p.id, 'epic', 'E');
    const r = await upload(p.id, e.id);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("'Epic Name'");
    expect(creates()).toHaveLength(0);
    stub({ fields: [{ id: 'customfield_10302', name: 'Epic Name', custom: true }] });
    const e2 = await mk(p.id, 'epic', 'E2'); await upload(p.id, e2.id);
    const s = await mk(p.id, 'story', 'S', e2.id);
    const r2 = await upload(p.id, s.id);
    expect(r2.status).toBe(400);
    expect(r2.body.error.message).toContain("'Epic Link'");
  });

  it('409 when the parent is not in Jira yet', async () => {
    env(); stub();
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); const s = await mk(p.id, 'story', 'S', e.id);
    const r = await upload(p.id, s.id);
    expect(r.status).toBe(409);
    expect(st.calls).toHaveLength(0);
  });

  it('409 when the issue is already linked', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    await upload(p.id, t.id);
    st.calls.length = 0;
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('KEY-100');
    expect(st.calls).toHaveLength(0);
  });

  it('a Jira rejection leaves the local row unchanged and relays the message', async () => {
    env(); stub({ createFail: true });
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await upload(p.id, t.id);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('bad summary');
    await unchanged(p.id, t.id);
  });

  it('a Jira outage maps to 502 and leaves the row unchanged', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await upload(p.id, t.id)).status).toBe(502);
    await unchanged(p.id, t.id);
  });

  it('404 for an unknown issue', async () => {
    env(); stub();
    const p = await project();
    expect((await upload(p.id, 999)).status).toBe(404);
  });
});

describe('re-import after upload (AC4)', () => {
  it('links the uploaded issue by key and creates no duplicate', async () => {
    env(); stub();
    const p = await project({ jiraJql: 'project = KEY', jiraLabel: 'pj-track' });
    const e = await mk(p.id, 'epic', 'E'); const s = await mk(p.id, 'story', 'S', e.id);
    await upload(p.id, e.id); await upload(p.id, s.id);
    st.issues = [jiraIssue('KEY-100', 'Epic', 'E'), jiraIssue('KEY-101', 'Story', 'S', { customfield_10301: 'KEY-100' })];
    const r = await api('POST', `/api/projects/${p.id}/jira/import`);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(0);
    const list = (await api('GET', `/api/issues?project=${p.id}`)).body;
    expect(list.filter((i: any) => i.title === 'E')).toHaveLength(1);
    expect(list.filter((i: any) => i.title === 'S')).toHaveLength(1);
    expect(list.find((i: any) => i.title === 'E').jiraKey).toBe('KEY-100');
  });
});

describe('update (AC5)', () => {
  // Import links the task and stamps jira_synced_at, so the conflict check has a baseline.
  const linked = async (jiraOver: any = {}, projOver: any = {}) => {
    env();
    const issue = jiraIssue('KEY-7', 'Task', 'Old', jiraOver);
    stub({ issues: [issue], existing: { fields: { updated: '2000-01-01T00:00:00.000+0000', labels: ['keep-me'], ...jiraOver.__existing } } });
    const p = await project({ jiraJql: 'project = KEY', ...projOver });
    expect((await api('POST', `/api/projects/${p.id}/jira/import`)).status).toBe(200);
    const t = (await api('GET', `/api/issues?project=${p.id}`)).body[0];
    await api('PUT', `/api/issues/${t.id}?project=${p.id}`, { type: 'task', title: 'New title', description: 'New desc', state: 'open' });
    st.calls.length = 0;
    return { p, t };
  };

  it('pushes only summary, description and labels, keeping existing labels', async () => {
    const { p, t } = await linked({}, { jiraLabel: 'pj-track' });
    const r = await update(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://jira.local/browse/KEY-7');
    const put = writes()[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://jira.local/rest/api/2/issue/KEY-7');
    expect(put.body).toEqual({ fields: { summary: 'New title', description: 'New desc\n\n_Updated from pjPlanner_', labels: ['keep-me', 'pj-track'] } });
    expect(writes()).toHaveLength(1);
  });

  it('leaves labels untouched when the project has no label, and does not re-add an existing one', async () => {
    const { p, t } = await linked();
    await update(p.id, t.id);
    expect(writes()[0].body.fields.labels).toBeUndefined();
    st.existing = { fields: { updated: '2000-01-01T00:00:00.000+0000', labels: ['pj-track', 'x'] } };
    const q = await linked({}, { jiraLabel: 'pj-track' });
    st.existing = { fields: { updated: '2000-01-01T00:00:00.000+0000', labels: ['pj-track', 'x'] } };
    await update(q.p.id, q.t.id);
    expect(writes()[0].body.fields.labels).toEqual(['pj-track', 'x']);
  });

  it('409 with a jiraUpdated flag when Jira changed after the last import; force overrides', async () => {
    const { p, t } = await linked();
    st.existing = { fields: { updated: '2999-01-01T00:00:00.000+0000', labels: [] } };
    const r = await update(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('conflict');
    expect(r.body.error.extra).toMatchObject({ jiraUpdated: true });
    expect(r.body.error.extra.jiraUpdatedAt).toContain('2999');
    expect(writes()).toHaveLength(0);
    const f = await update(p.id, t.id, { force: true });
    expect(f.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('an update followed by a second update does not conflict', async () => {
    const { p, t } = await linked();
    expect((await update(p.id, t.id)).status).toBe(200);
    // Jira now reports an `updated` newer than the project's import time (its own edit from our PUT)
    expect(Date.parse(st.existing.fields.updated.replace(/(\d\d)(\d\d)$/, '$1:$2'))).toBeGreaterThan(Date.now());
    expect((await update(p.id, t.id)).status).toBe(200);
    expect(writes()).toHaveLength(2);
  });

  it('a failed read after the write still succeeds, then the next update conflicts until forced', async () => {
    const { p, t } = await linked();
    st.failUpdatedRead = true;
    const r = await update(p.id, t.id);
    expect(r.status).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(r.body.issue).toMatchObject({ title: 'New title', description: 'New desc', jiraKey: 'KEY-7' });
    const next = await update(p.id, t.id);
    expect(next.status).toBe(409);
    expect(next.body.error.extra.jiraUpdated).toBe(true);
    expect(writes()).toHaveLength(1);
    expect((await update(p.id, t.id, { force: true })).status).toBe(200);
    expect(writes()).toHaveLength(2);
  });

  it('a never-imported, never-read project (null jira_synced_at) conflicts unless forced', async () => {
    env(); stub({ existing: { fields: { labels: [] } } });
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    await upload(p.id, t.id);
    st.calls.length = 0;
    const r = await update(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.extra.jiraUpdated).toBe(true);
    expect(writes()).toHaveLength(0);
    expect((await update(p.id, t.id, { force: true })).status).toBe(200);
  });

  it('an unreadable Jira updated (no value) conflicts with a null jiraUpdatedAt unless forced', async () => {
    const { p, t } = await linked();
    st.existing = { fields: { labels: [] } };
    const r = await update(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.extra).toEqual({ jiraUpdated: true, jiraUpdatedAt: null });
    expect(writes()).toHaveLength(0);
    expect((await update(p.id, t.id, { force: true })).status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('accepts a Z offset on Jira updated', async () => {
    const { p, t } = await linked();
    st.existing = { fields: { updated: '2999-01-01T00:00:00.000Z', labels: [] } };
    const r = await update(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.extra.jiraUpdatedAt).toContain('2999');
    st.existing = { fields: { updated: '2000-01-01T00:00:00.000Z', labels: [] } };
    expect((await update(p.id, t.id)).status).toBe(200);
  });

  it('409 when the issue is not linked', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    expect((await update(p.id, t.id)).status).toBe(409);
    expect(st.calls).toHaveLength(0);
  });

  it('404 when the issue is gone from Jira', async () => {
    const { p, t } = await linked();
    st.existing = null;
    const r = await update(p.id, t.id, { force: true });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('a Jira rejection leaves the local issue unchanged', async () => {
    const { p, t } = await linked();
    st.putFail = true;
    const r = await update(p.id, t.id, { force: true });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('nope');
    const after = (await api('GET', `/api/issues/${t.id}?project=${p.id}`)).body;
    expect(after).toMatchObject({ title: 'New title', description: 'New desc', jiraKey: 'KEY-7' });
  });
});

describe('write key (AC7)', () => {
  it('both endpoints answer 401 without the key and pass with it', async () => {
    env({ WRITE_KEY: 'secret' }); stub();
    const k = { 'x-api-key': 'secret' };
    const p = (await api('POST', '/api/projects', { name: 'P', jiraWrite: true, jiraEnabled: true, jiraProjectId: '10000' }, k)).body;
    const t = (await api('POST', `/api/issues?project=${p.id}`, { type: 'story', title: 'T' }, k)).body;
    expect((await upload(p.id, t.id)).status).toBe(401);
    expect((await update(p.id, t.id, {})).status).toBe(401);
    expect((await upload(p.id, t.id, { 'x-api-key': 'wrong' })).status).toBe(401);
    expect(st.calls).toHaveLength(0);
    expect((await upload(p.id, t.id, k)).status).toBe(200);
    expect((await update(p.id, t.id, { force: true }, k)).status).toBe(200);
  });
});

describe('per-project Jira switch (jiraEnabled)', () => {
  it('round-trips, validates, defaults off, and is never exported or imported', async () => {
    const d = (await api('POST', '/api/projects', { name: 'Plain' })).body;
    expect(d.jiraEnabled).toBe(false);
    const p = await project();
    expect(p.jiraEnabled).toBe(true);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name })).body.jiraEnabled).toBe(true);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraEnabled: false })).body.jiraEnabled).toBe(false);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraEnabled: 'yes' })).status).toBe(400);
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraEnabled: true });
    const file = (await api('GET', `/api/projects/${p.id}/export`)).body;
    expect(JSON.stringify(file)).not.toMatch(/jiraEnabled|jira_enabled/);
    const q = (await api('POST', '/api/projects/import', { ...file, project: { ...file.project, jiraEnabled: true } })).body;
    expect(q.jiraEnabled).toBe(false);
  });

  it('existing projects with a filter or label are enabled by the migration, others are not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-jira-'));
    const file = path.join(dir, 'old.db');
    const a0 = buildApp(file);
    await a0.close();
    const raw = new Database(file);
    raw.exec('ALTER TABLE projects DROP COLUMN jira_enabled');
    raw.exec("INSERT INTO projects (name, jira_jql) VALUES ('Q', 'a = b'), ('L', NULL)");
    raw.exec("UPDATE projects SET jira_label = 'x' WHERE name = 'L'");
    raw.exec("INSERT INTO projects (name) VALUES ('None')");
    raw.close();
    for (let i = 0; i < 2; i++) {
      const a = buildApp(file);
      const list = (await a.inject({ method: 'GET', url: '/api/projects' })).json() as any[];
      expect(list.map((r) => [r.name, r.jiraEnabled])).toEqual([['Q', true], ['L', true], ['None', false]]);
      await a.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks upload, update and import with 409 when disabled, without calling Jira', async () => {
    env(); stub();
    const p = await project({ jiraEnabled: false, jiraJql: 'project = KEY' });
    const i = await mk(p.id, 'epic', 'E');
    for (const r of [await upload(p.id, i.id), await update(p.id, i.id, {}), await api('POST', `/api/projects/${p.id}/jira/import`)]) {
      expect(r.status).toBe(409);
      expect(r.body.error.message).toBe('Jira is disabled for this project');
    }
    expect(st.calls).toHaveLength(0);
  });

  it('disabling keeps the data, and test and preview stay allowed', async () => {
    env(); stub({ issues: [jiraIssue('K-1', 'Epic', 'E')] });
    const p = await project({ jiraJql: 'project = KEY', jiraLabel: 'pj' });
    expect((await api('POST', `/api/projects/${p.id}/jira/import`)).status).toBe(200);
    const off = (await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraEnabled: false })).body;
    expect(off).toMatchObject({ jiraEnabled: false, jiraJql: 'project = KEY', jiraLabel: 'pj', jiraProjectId: '10000' });
    expect((await api('GET', `/api/issues?project=${p.id}`)).body[0].jiraKey).toBe('K-1');
    expect((await api('POST', '/api/jira/preview', { jql: 'a = b' })).status).toBe(200);
    expect((await api('POST', '/api/jira/test')).status).not.toBe(409);
  });

  it('status lists what the server is missing', async () => {
    env({ JIRA_URL: '' });
    expect((await api('GET', '/api/jira/status')).body).toMatchObject({ configured: false, available: false, missing: ['JIRA_URL'] });
    env({ JIRA_URL: 'https://jira.local', JIRA_TOKEN: '' });
    expect((await api('GET', '/api/jira/status')).body.missing).toEqual(['JIRA_TOKEN']);
    env({ JIRA_TOKEN: 't', JIRA_WRITE: '' });
    expect((await api('GET', '/api/jira/status')).body).toMatchObject({ configured: true, available: true, missing: [], writeAllowed: false });
  });
});

describe('root issues upload', () => {
  const form = (pid: number, iid: number, qs = '') => api('GET', `/api/issues/${iid}/jira/upload-form?project=${pid}${qs}`);
  const post = (pid: number, iid: number, payload?: any) => api('POST', `/api/issues/${iid}/jira/upload?project=${pid}`, payload);
  beforeEach(() => env());

  it('a root task previews and uploads as a Task in the configured project, with the label and no link', async () => {
    stub();
    const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'task', 'T');
    const f = await form(p.id, t.id);
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ project: { key: 'KEY', locked: false }, issueType: { name: 'Task' }, link: { kind: 'none' } });
    const r = await post(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.issue.jiraKey).toBeTruthy();
    expect(st.calls.filter((c) => c.url.includes('issueLink'))).toHaveLength(0);
  });

  it('a root task is 409 when the project has no Jira project id', async () => {
    stub();
    const p = await project({ jiraProjectId: null } as any); const t = await mk(p.id, 'task', 'T');
    expect((await post(p.id, t.id)).status).toBe(409);
  });

  it.each(['epic', 'story', 'bug'])('a root %s is uploaded', async (type) => {
    stub();
    const p = await project(); const i = await mk(p.id, type, 'R');
    expect((await form(p.id, i.id)).status).toBe(200);
    expect((await post(p.id, i.id)).status).toBe(200);
  });

  it.each(['epic', 'story', 'bug'])('a task under a Jira %s is still uploaded', async (type) => {
    stub();
    const p = await project(); const parent = await mk(p.id, type, 'P'); await upload(p.id, parent.id);
    const t = await mk(p.id, 'task', 'T', parent.id);
    expect((await form(p.id, t.id)).status).toBe(200);
    expect((await post(p.id, t.id)).status).toBe(200);
  });
});

describe('upload form (preview)', () => {
  const form = (pid: number, iid: number, qs = '') => api('GET', `/api/issues/${iid}/jira/upload-form?project=${pid}${qs}`);
  const post = (pid: number, iid: number, payload: any, headers?: any) => api('POST', `/api/issues/${iid}/jira/upload?project=${pid}`, payload, headers);
  const metaUrls = () => st.calls.filter((c) => c.url.includes('/createmeta'));
  const PRIORITY = { fieldId: 'priority', name: 'Priority', required: true, schema: { type: 'priority' }, allowedValues: [{ id: '1', name: 'High' }, { id: '2', name: 'Low' }] };
  const TEAM = { fieldId: 'customfield_20001', name: 'Team', required: false, schema: { type: 'string' } };
  const SKIP = [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }, { fieldId: 'customfield_10301', name: 'Epic Link', schema: { type: 'string' } }, { fieldId: 'customfield_10302', name: 'Epic Name', schema: { type: 'string' } }];
  beforeEach(() => env());

  it('a root issue previews the configured project, its types, values and fields, and creates nothing', async () => {
    stub({ meta: [...SKIP, PRIORITY, TEAM] });
    const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'story', 'Root');
    const r = await form(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      project: { ref: '10000', key: 'KEY', id: '10000', name: 'Key Project', locked: false },
      issueType: { id: '2', name: 'Story' },
      values: { title: 'Root', description: 'Root desc', labels: ['pj-track'] },
      link: { kind: 'none', label: 'No parent' }, match: null,
    });
    expect(r.body.issueTypes).toContainEqual({ id: '5', name: 'Sub-task', subtask: true });
    expect(r.body.fields.map((f: any) => f.id)).toEqual(['priority', 'customfield_20001']);
    expect(r.body.fields[0]).toMatchObject({ required: true, kind: 'priority', allowedValues: [{ id: '1', name: 'High' }, { id: '2', name: 'Low' }] });
    expect(writes()).toHaveLength(0);
    expect(st.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(metaUrls()[0].url).toContain('/issue/createmeta/KEY/issuetypes/2');
  });

  it('values.labels is empty without an integration label', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    expect((await form(p.id, t.id)).body.values.labels).toEqual([]);
  });

  it('a root can pick another Jira project with jiraProject, and a bad value is 400', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await form(p.id, t.id, '&jiraProject=PROJ');
    expect(r.body.project).toMatchObject({ ref: 'PROJ', key: 'PROJ', locked: false });
    expect(st.calls.some((c) => c.url.endsWith('/rest/api/2/project/PROJ'))).toBe(true);
    expect((await form(p.id, t.id, '&jiraProject=a%20b')).status).toBe(400);
  });

  it('a parented issue is locked to its parent\'s project and ignores the param', async () => {
    stub();
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); await upload(p.id, e.id);
    const s = await mk(p.id, 'story', 'S', e.id);
    st.calls.length = 0;
    const r = await form(p.id, s.id, '&jiraProject=OTHER');
    expect(r.body.project).toMatchObject({ ref: 'KEY', locked: true });
    expect(st.calls.some((c) => c.url.includes('/project/OTHER'))).toBe(false);
  });

  it('link line and default type: epic child, linked Task under story and bug', async () => {
    stub();
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); await upload(p.id, e.id);
    const s = await mk(p.id, 'story', 'S', e.id);
    expect((await form(p.id, s.id)).body).toMatchObject({ issueType: { name: 'Story' }, link: { kind: 'epic', parentKey: 'KEY-100', label: 'In epic KEY-100' } });
    for (const type of ['story', 'bug']) {
      const par = await mk(p.id, type, `p-${type}`); await upload(p.id, par.id);
      const key = (await api('GET', `/api/issues/${par.id}?project=${p.id}`)).body.jiraKey;
      const t = await mk(p.id, 'task', `t-${type}`, par.id);
      expect((await form(p.id, t.id)).body).toMatchObject({ issueType: { name: 'Task' }, link: { kind: 'link', parentKey: key, label: `Linked to ${key}`, linkType: 'Relates', linkTypes: [{ name: 'Blocks' }, { name: 'Relates' }] } });
    }
  });

  it('issueType picks another type of the project ignoring case; a missing type is 400', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    expect((await form(p.id, t.id, '&issueType=bug')).body.issueType).toEqual({ id: '3', name: 'Bug' });
    const r = await form(p.id, t.id, '&issueType=Nope');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Nope');
  });

  it('shows the match banner for a same-type same-title issue of the filter, none for other titles or taken keys', async () => {
    stub({ issues: [jiraIssue('KEY-7', 'Story', ' same ')] });
    const p = await project({ jiraLabel: 'pj-track' });
    const t = await mk(p.id, 'story', 'Same'); const o = await mk(p.id, 'story', 'Other');
    expect((await form(p.id, t.id)).body.match).toEqual({ key: 'KEY-7', url: 'https://jira.local/browse/KEY-7', title: ' same ' });
    expect((await form(p.id, o.id)).body.match).toBeNull();
    await post(p.id, t.id, { linkExisting: 'KEY-7' });
    expect((await form(p.id, (await mk(p.id, 'story', 'Same')).id)).body.match).toBeNull();
  });

  it('no match lookup without a filter; a failing lookup gives match null instead of failing the form', async () => {
    stub({ issues: [jiraIssue('KEY-7', 'Task', 'Same')] });
    const a = await project(); const ta = await mk(a.id, 'story', 'Same');
    expect((await form(a.id, ta.id)).body.match).toBeNull();
    expect(st.calls.some((c) => c.url.includes('/search'))).toBe(false);
    st.searchFail = true;
    const b = await project({ jiraLabel: 'x' }); const tb = await mk(b.id, 'story', 'Same');
    const r = await form(b.id, tb.id);
    expect(r.status).toBe(200);
    expect(r.body.match).toBeNull();
  });

  it('the gate answers 409 with zero Jira calls', async () => {
    stub();
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); const s = await mk(p.id, 'story', 'S', e.id);
        const off = await project({ jiraEnabled: false }); const o = await mk(off.id, 'story', 'O');
    const nowrite = await project({ jiraWrite: false }); const w = await mk(nowrite.id, 'story', 'W');
    expect((await form(p.id, s.id)).status).toBe(409); // parent not uploaded
    expect((await form(off.id, o.id)).body.error.message).toBe('Jira is disabled for this project');
    expect((await form(nowrite.id, w.id)).status).toBe(409);
    process.env.JIRA_WRITE = '0';
    expect((await form(p.id, e.id)).body.error.message).toMatch(/JIRA_WRITE/);
    expect(st.calls).toHaveLength(0);
  });

  it('409 for an already linked issue and 404 for an unknown one', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T'); await upload(p.id, t.id);
    st.calls.length = 0;
    const r = await form(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('KEY-100');
    expect((await form(p.id, 999)).status).toBe(404);
    expect(st.calls).toHaveLength(0);
  });

  it('a root with no configured project previews an empty form without calling Jira', async () => {
    stub();
    const p = await project({ jiraProjectId: undefined, jiraLabel: 'pj' }); const t = await mk(p.id, 'story', 'T');
    const r = await form(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.project).toEqual({ ref: null, locked: false });
    expect(r.body.issueTypes).toEqual([]);
    expect(r.body.fields).toEqual([]);
    expect(r.body.values.title).toBe('T');
    expect(st.calls).toHaveLength(0);
  });

  it('a root with no configured project previews normally when jiraProject is given', async () => {
    stub();
    const p = await project({ jiraProjectId: undefined }); const t = await mk(p.id, 'story', 'T');
    expect((await form(p.id, t.id, '&jiraProject=PROJ')).status).toBe(200);
  });

  it('is readable without the write key', async () => {
    env({ WRITE_KEY: 'secret' }); stub();
    const k = { 'x-api-key': 'secret' };
    const p = (await api('POST', '/api/projects', { name: 'P', jiraWrite: true, jiraEnabled: true, jiraProjectId: '10000' }, k)).body;
    const t = (await api('POST', `/api/issues?project=${p.id}`, { type: 'story', title: 'T' }, k)).body;
    expect((await form(p.id, t.id)).status).toBe(200);
    expect((await post(p.id, t.id, { title: 'X' })).status).toBe(401);
    expect(creates()).toHaveLength(0);
    expect((await post(p.id, t.id, { title: 'X' }, k)).status).toBe(200);
  });

  describe('createmeta shapes', () => {
    const ids = async () => {
      const p = await project(); const t = await mk(p.id, 'story', 'T');
      return (await form(p.id, t.id)).body.fields.map((f: any) => f.id);
    };
    const many = Array.from({ length: 120 }, (_, i) => ({ fieldId: `customfield_${30000 + i}`, name: `F${i}`, schema: { type: 'string' } }));

    it('pages through the new endpoint by total/isLast', async () => {
      stub({ meta: many, metaPageSize: 50 });
      expect(await ids()).toHaveLength(120);
      expect(metaUrls().map((c) => c.url.match(/startAt=(\d+)/)![1])).toEqual(['0', '50', '100']);
      expect(metaUrls().every((c) => c.url.includes('maxResults=50'))).toBe(true);
    });

    it.each(['old404', 'old405'] as const)('falls back to the expanded shape on %s', async (metaMode) => {
      stub({ meta: [PRIORITY, TEAM], metaMode });
      expect(await ids()).toEqual(['priority', 'customfield_20001']);
      const old = metaUrls().find((c) => !c.url.includes('/issuetypes/'))!;
      expect(old.url).toContain('projectKeys=KEY');
      expect(old.url).toContain('issuetypeIds=2');
      expect(decodeURIComponent(old.url)).toContain('expand=projects.issuetypes.fields');
    });

    it('unreadable metadata gives no fields and the form still loads', async () => {
      stub({ meta: [PRIORITY], metaMode: 'none' });
      const p = await project(); const t = await mk(p.id, 'story', 'T');
      const r = await form(p.id, t.id);
      expect(r.status).toBe(200);
      expect(r.body.fields).toEqual([]);
      expect(r.body.fieldsUnavailable).toBe(true);
    });

    it('readable metadata does not flag fieldsUnavailable', async () => {
      stub({ meta: [PRIORITY] });
      const p = await project(); const t = await mk(p.id, 'story', 'T');
      expect((await form(p.id, t.id)).body.fieldsUnavailable).toBeFalsy();
    });

    it('explicit upload with extra fields is refused clearly when metadata is unreadable, base fields still create', async () => {
      stub({ metaMode: 'none' });
      const p = await project(); const t = await mk(p.id, 'story', 'T'); const u = await mk(p.id, 'story', 'U');
      const r = await post(p.id, t.id, { title: 'X', fields: { customfield_1: 'v' } });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('did not tell us which fields');
      expect(creates()).toHaveLength(0);
      expect((await post(p.id, u.id, { title: 'Y', fields: {} })).status).toBe(200);
    });

    it('preview reads /field once', async () => {
      stub({ meta: [PRIORITY] });
      const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'story', 'T');
      expect((await form(p.id, t.id)).status).toBe(200);
      expect(st.calls.filter((c) => c.url.endsWith('/rest/api/2/field'))).toHaveLength(1);
      expect(st.calls.some((c) => c.url.includes('/rest/api/2/search'))).toBe(true);
    });

    it('creating still works when metadata is unreadable', async () => {
      stub({ metaMode: 'none' });
      const p = await project(); const t = await mk(p.id, 'story', 'T');
      expect((await post(p.id, t.id, { title: 'X' })).status).toBe(200);
    });
  });
});

describe('upload with form values', () => {
  const post = (pid: number, iid: number, payload: any, headers?: any) => api('POST', `/api/issues/${iid}/jira/upload?project=${pid}`, payload, headers);
  const local = async (pid: number, iid: number) => (await api('GET', `/api/issues/${iid}?project=${pid}`)).body;
  const PRIORITY = { fieldId: 'priority', name: 'Priority', required: true, schema: { type: 'priority' }, allowedValues: [{ id: '1', name: 'High' }] };
  const TEAM = { fieldId: 'customfield_20001', name: 'Team', required: false, schema: { type: 'string' } };
  const OPTS = { fieldId: 'customfield_20002', name: 'Opts', required: false, schema: { type: 'array', items: 'option' }, allowedValues: [{ id: '5', value: 'A' }, { id: '6', value: 'B' }] };
  beforeEach(() => env());

  it('explicit labels [] sends none; omitted labels sends the integration label', async () => {
    stub({ meta: [PRIORITY] });
    const p = await project({ jiraLabel: 'pj-track' });
    const a = await mk(p.id, 'story', 'A'); const b = await mk(p.id, 'story', 'B'); const c = await mk(p.id, 'story', 'C');
    expect((await post(p.id, a.id, { labels: [], fields: { priority: '1' } })).status).toBe(200);
    expect(creates()[0].body.fields.labels).toBeUndefined();
    expect((await post(p.id, b.id, { fields: { priority: '1' } })).status).toBe(200);
    expect(creates()[1].body.fields.labels).toEqual(['pj-track']);
    expect((await post(p.id, c.id, { labels: ['x', 'x', 'y'], fields: { priority: '1' } })).status).toBe(200);
    expect(creates()[2].body.fields.labels).toEqual(['x', 'y']);
  });

  it('malformed labels are 400', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    for (const labels of ['x', ['a b'], [' a b '], [1], ['']]) expect((await post(p.id, t.id, { labels })).status).toBe(400);
    expect(st.calls).toHaveLength(0);
  });

  it('labels are trimmed before the space check', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    expect((await post(p.id, t.id, { labels: [' x '] })).status).toBe(200);
    expect(creates()[0].body.fields.labels).toEqual(['x']);
  });

  it('merges extra fields converted to Jira shapes', async () => {
    stub({ meta: [PRIORITY, TEAM, OPTS] });
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await post(p.id, t.id, { fields: { priority: '1', customfield_20001: ' abc ', customfield_20002: ['5', '6'] } });
    expect(r.status).toBe(200);
    expect(creates()[0].body.fields).toMatchObject({ summary: 'T', priority: { id: '1' }, customfield_20001: 'abc', customfield_20002: [{ id: '5' }, { id: '6' }], issuetype: { name: 'Story' } });
  });

  it('Epic Name, Epic Link and parent are not settable and keep their own values', async () => {
    stub({ meta: [TEAM, { fieldId: 'customfield_10302', name: 'Epic Name', schema: { type: 'string' } }] });
    const p = await project(); const e = await mk(p.id, 'epic', 'Big');
    for (const bad of [{ customfield_10302: 'hack' }, { customfield_10301: 'X-1' }, { parent: { key: 'X-1' } }, { summary: 'x' }, { project: 'x' }]) {
      expect((await post(p.id, e.id, { fields: bad })).status).toBe(400);
    }
    expect(creates()).toHaveLength(0);
    expect((await post(p.id, e.id, { title: 'Renamed', fields: { customfield_20001: 'v' } })).status).toBe(200);
    expect(creates()[0].body.fields).toMatchObject({ summary: 'Renamed', customfield_10302: 'Renamed', customfield_20001: 'v' });
  });

  it('an epic child still gets Epic Link and a task under a story is linked in explicit mode', async () => {
    stub({ meta: [TEAM] });
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); await upload(p.id, e.id);
    const s = await mk(p.id, 'story', 'S', e.id); st.calls.length = 0;
    await post(p.id, s.id, { fields: { customfield_20001: 'v' } });
    expect(creates()[0].body.fields).toMatchObject({ customfield_10301: 'KEY-100', customfield_20001: 'v' });
    await upload(p.id, s.id).catch(() => null);
    const t = await mk(p.id, 'task', 'T', s.id); st.calls.length = 0;
    await post(p.id, t.id, { description: 'd' });
    expect(creates()[0].body.fields).toMatchObject({ issuetype: { name: 'Task' }, description: 'd\n\n_Updated from pjPlanner_' });
    expect(creates()[0].body.fields.parent).toBeUndefined();
    expect(linkCalls()[0].body.outwardIssue).toEqual({ key: 'KEY-101' });
  });

  it('issueType and projectRef from the form decide the type and project; a parented issue ignores projectRef', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    await post(p.id, t.id, { issueType: 'bug', projectRef: 'PROJ' });
    expect(creates()[0].body.fields).toMatchObject({ issuetype: { name: 'Bug' }, project: { key: 'PROJ' } });
    const e = await mk(p.id, 'epic', 'E'); await upload(p.id, e.id);
    const s = await mk(p.id, 'story', 'S', e.id); st.calls.length = 0;
    await post(p.id, s.id, { projectRef: 'PROJ' });
    expect(creates()[0].body.fields.project).toEqual({ key: 'KEY' });
    expect((await post(p.id, (await mk(p.id, 'story', 'N')).id, { issueType: 'Nope' })).status).toBe(400);
  });

  it('edited title and description are saved locally only after Jira succeeds', async () => {
    stub();
    const p = await project(); const t = await mk(p.id, 'story', 'Old');
    st.createFail = true;
    expect((await post(p.id, t.id, { title: 'New', description: 'New desc' })).status).toBe(400);
    expect(await local(p.id, t.id)).toMatchObject({ title: 'Old', description: 'Old desc', jiraKey: null });
    st.createFail = false;
    const r = await post(p.id, t.id, { title: '  New  ', description: '  New desc ' });
    expect(r.status).toBe(200);
    expect(creates()[0].body.fields).toMatchObject({ summary: 'New', description: 'New desc\n\n_Updated from pjPlanner_' });
    expect(r.body.issue).toMatchObject({ title: 'New', description: 'New desc', jiraKey: 'KEY-100' });
    expect(await local(p.id, t.id)).toMatchObject({ title: 'New', description: 'New desc', jiraKey: 'KEY-100' });
  });

  it('only the given text is changed locally; an empty description is allowed, an empty title is 400', async () => {
    stub();
    const p = await project(); const a = await mk(p.id, 'story', 'A'); const b = await mk(p.id, 'story', 'B');
    await post(p.id, a.id, { title: 'A2' });
    expect(await local(p.id, a.id)).toMatchObject({ title: 'A2', description: 'A desc' });
    await post(p.id, b.id, { description: '' });
    expect(await local(p.id, b.id)).toMatchObject({ title: 'B', description: '' });
    const c = await mk(p.id, 'story', 'C');
    for (const title of ['', '   ', 5]) expect((await post(p.id, c.id, { title })).status).toBe(400);
  });

  it('required fields missing are 400 and nothing is created; unknown ones too', async () => {
    stub({ meta: [PRIORITY, TEAM] });
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await post(p.id, t.id, { title: 'T2' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('Priority (priority)');
    expect((await post(p.id, t.id, { fields: { priority: '1', nope: 'x' } })).status).toBe(400);
    expect((await post(p.id, t.id, { fields: { priority: '9' } })).status).toBe(400);
    expect((await post(p.id, t.id, { fields: { priority: '' } })).status).toBe(400);
    expect(creates()).toHaveLength(0);
    expect((await local(p.id, t.id)).jiraKey).toBeNull();
  });

  it('a required field Jira offers but pjPlanner cannot fill blocks with a clear message', async () => {
    stub({ meta: [{ fieldId: 'customfield_9', name: 'Cascade', required: true, schema: { type: 'option' }, allowedValues: [{ id: '1', value: 'A', children: [{ id: '2', value: 'B' }] }] }] });
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    const r = await post(p.id, t.id, { title: 'T' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/cannot fill it/);
    expect((await post(p.id, t.id, { fields: { customfield_9: '1' } })).status).toBe(400);
  });

  it('a malformed body is a 400 before the gate checks', async () => {
    stub();
    const p = await project(); const e = await mk(p.id, 'epic', 'E'); const s = await mk(p.id, 'story', 'S', e.id);
    expect((await post(p.id, s.id, { labels: 'x' })).status).toBe(400);
    expect((await post(p.id, s.id, { labels: [] })).status).toBe(409);
    expect((await post(p.id, s.id, { linkExisting: 'nokey' })).status).toBe(400);
    expect((await post(p.id, s.id, { fields: 'x' })).status).toBe(400);
    expect(st.calls).toHaveLength(0);
  });

  it('explicit mode does not auto-adopt a same-titled Jira issue; a bare POST still does', async () => {
    stub({ issues: [jiraIssue('KEY-7', 'Story', 'Same'), jiraIssue('KEY-8', 'Story', 'Same2')] });
    const p = await project({ jiraLabel: 'pj-track' });
    const a = await mk(p.id, 'story', 'Same'); const b = await mk(p.id, 'story', 'Same2');
    const r = await post(p.id, a.id, { title: 'Same' });
    expect(r.body.adopted).toBe(false);
    expect(creates()).toHaveLength(1);
    expect(st.calls.some((c) => c.url.includes('/search'))).toBe(false);
    expect((await upload(p.id, b.id)).body).toMatchObject({ adopted: true });
    expect((await post(p.id, (await mk(p.id, 'story', 'Z')).id, {})).body.adopted).toBe(false);
  });

  describe('linkExisting', () => {
    it('adopts the chosen issue, copying Jira content, and creates nothing', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Story', 'Other name')] });
      const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'story', 'Mine');
      const r = await post(p.id, t.id, { linkExisting: 'key-7' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ adopted: true, url: 'https://jira.local/browse/KEY-7' });
      expect(r.body.issue).toMatchObject({ jiraKey: 'KEY-7', title: 'Other name', description: 'KEY-7 jira desc' });
      expect(writes()).toHaveLength(0);
    });

    it('409 when the key is not in the filter result', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Story', 'x')] });
      const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'story', 'T');
      const r = await post(p.id, t.id, { linkExisting: 'KEY-8' });
      expect(r.status).toBe(409);
      expect(r.body.error.message).toContain('KEY-8');
      expect((await local(p.id, t.id)).jiraKey).toBeNull();
    });

    it('409 when already taken by another local issue', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Story', 'x')] });
      const p = await project({ jiraLabel: 'pj-track' });
      const a = await mk(p.id, 'story', 'A'); const b = await mk(p.id, 'story', 'B');
      expect((await post(p.id, a.id, { linkExisting: 'KEY-7' })).status).toBe(200);
      const r = await post(p.id, b.id, { linkExisting: 'KEY-7' });
      expect(r.status).toBe(409);
      expect(r.body.error.message).toMatch(/already linked/);
    });

    it('400 when the Jira issue is of a different type', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Task', 'x')] });
      const p = await project({ jiraLabel: 'pj-track' }); const t = await mk(p.id, 'story', 'T');
      const r = await post(p.id, t.id, { linkExisting: 'KEY-7' });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/same type/);
      expect((await local(p.id, t.id)).jiraKey).toBeNull();
    });

    it('409 when the project has no filter, without searching', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Story', 'x')] });
      const p = await project(); const t = await mk(p.id, 'story', 'T');
      expect((await post(p.id, t.id, { linkExisting: 'KEY-7' })).status).toBe(409);
      expect(st.calls.some((c) => c.url.includes('/search'))).toBe(false);
    });

    it('still passes the gate first: an uploaded parent is required', async () => {
      stub({ issues: [jiraIssue('KEY-7', 'Task', 'x')] });
      const p = await project({ jiraLabel: 'pj-track' }); const e = await mk(p.id, 'epic', 'E'); const s = await mk(p.id, 'story', 'S', e.id);
      expect((await post(p.id, s.id, { linkExisting: 'KEY-7' })).status).toBe(409);
      expect(st.calls).toHaveLength(0);
    });
  });
});

describe('refresh from Jira', () => {
  const refresh = (pid: number, iid: number) => api('POST', `/api/issues/${iid}/jira/refresh?project=${pid}`);
  const jiraSide = (o: { status?: string; cat?: string; summary?: string; description?: string | null; updated?: string } = {}) => ({
    fields: { summary: o.summary ?? 'From Jira', description: o.description === undefined ? 'Jira body' : o.description, status: { name: o.status ?? 'To Do', statusCategory: { key: o.cat ?? 'new' } }, updated: o.updated ?? '2031-01-01T00:00:00.000+0000', labels: [] },
  });
  const linkedTask = async (over: any = {}) => {
    env(); stub();
    const p = await project(over);
    const s = await mk(p.id, 'story', 'Parent'); await upload(p.id, s.id);
    const t = await mk(p.id, 'task', 'Local', s.id);
    await upload(p.id, t.id);
    st.calls.length = 0;
    return { p, t, key: 'KEY-100' };
  };
  const get = async (pid: number, iid: number) => (await api('GET', `/api/issues/${iid}?project=${pid}`)).body;

  it.each([
    ['Done', 'done', 'closed'], ['Code Review', 'indeterminate', 'code_review'], ['QA', 'indeterminate', 'test_validation'],
    ['Validating', 'indeterminate', 'test_validation'], ['In Progress', 'indeterminate', 'open'],
  ])('maps %s (%s) to %s', async (status, cat, state) => {
    const { p, t } = await linkedTask();
    st.existing = jiraSide({ status, cat });
    const r = await refresh(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.issue.state).toBe(state);
  });

  it('replaces title and description only, and never writes to Jira', async () => {
    const { p, t } = await linkedTask();
    const owner = (await api('POST', `/api/owners?project=${p.id}`, { name: 'O' })).body;
    await api('PUT', `/api/modules/${mods.get(p.id)}?project=${p.id}`, { name: 'M', ownerIds: [owner.id] });
    const sprint = (await api('POST', `/api/sprints?project=${p.id}`, { name: 'S' })).body;
    const put = await api('PUT', `/api/issues/${t.id}?project=${p.id}`, { type: 'task', title: 'Local', description: 'x', state: 'open', moduleId: mods.get(p.id), ownerId: owner.id, sprintId: sprint.id, estimate: 5 });
    const before = await get(p.id, t.id);
    if (put.status !== 200) throw new Error(JSON.stringify(put.body));
    expect(before).toMatchObject({ moduleId: mods.get(p.id), estimate: 5 });
    expect(before.ownerId).not.toBeNull();
    expect(before.sprintId).not.toBeNull();
    st.existing = jiraSide();
    const r = await refresh(p.id, t.id);
    expect(r.body.issue).toMatchObject({ title: 'From Jira', description: 'Jira body', state: 'open' });
    for (const k of ['type', 'parentId', 'moduleId', 'ownerId', 'sprintId', 'estimate']) expect(r.body.issue[k]).toEqual(before[k]);
    expect(st.calls.length).toBeGreaterThan(0);
    expect(writes()).toHaveLength(0);
    expect(st.calls[0].url).toContain('fields=summary,description,status,updated');
  });

  it('keeps closed_at while still closed and clears it when leaving closed', async () => {
    const { p, t } = await linkedTask();
    await api('PUT', `/api/issues/${t.id}?project=${p.id}`, { type: 'task', title: 'Local', description: 'x', state: 'closed', moduleId: mods.get(p.id) });
    const closedAt = (await get(p.id, t.id)).closedAt;
    expect(closedAt).toBeTruthy();
    st.existing = jiraSide({ status: 'Done', cat: 'done' });
    expect((await refresh(p.id, t.id)).body.issue.closedAt).toBe(closedAt);
    st.existing = jiraSide({ status: 'To Do' });
    const r = await refresh(p.id, t.id);
    expect(r.body.issue.state).toBe('open');
    expect(r.body.issue.closedAt).toBeNull();
    st.existing = jiraSide({ status: 'Done', cat: 'done' });
    expect((await refresh(p.id, t.id)).body.issue.closedAt).toBeNull();
  });

  it('records Jira\'s updated so the next update does not conflict', async () => {
    const { p, t } = await linkedTask();
    st.existing = jiraSide({ updated: '2031-01-01T00:00:00.000+0000' });
    st.bumpOnPut = false;
    await refresh(p.id, t.id);
    st.calls.length = 0;
    const r = await update(p.id, t.id);
    expect(r.status).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it('a 404 from Jira leaves the issue unchanged', async () => {
    const { p, t } = await linkedTask();
    const before = await get(p.id, t.id);
    st.existing = null;
    const r = await refresh(p.id, t.id);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'not_found', message: 'Not found in Jira' });
    expect(await get(p.id, t.id)).toEqual(before);
  });

  it('refuses an unlinked issue with 409 and no Jira call', async () => {
    env(); stub();
    const p = await project(); const t = await mk(p.id, 'epic', 'E');
    const r = await refresh(p.id, t.id);
    expect(r.status).toBe(409);
    expect(st.calls).toHaveLength(0);
  });

  it('refuses when Jira is disabled for the project', async () => {
    const { p, t } = await linkedTask();
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraEnabled: false });
    st.calls.length = 0;
    expect((await refresh(p.id, t.id)).status).toBe(409);
    expect(st.calls).toHaveLength(0);
  });

  it('404 for an unknown issue', async () => {
    env(); stub();
    const p = await project();
    expect((await refresh(p.id, 9999)).status).toBe(404);
  });

  it('works with JIRA_WRITE off and the project\'s write switch off', async () => {
    const { p, t } = await linkedTask();
    process.env.JIRA_WRITE = '0';
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraWrite: false });
    st.existing = jiraSide({ summary: 'Pulled' });
    const r = await refresh(p.id, t.id);
    expect(r.status).toBe(200);
    expect(r.body.issue.title).toBe('Pulled');
    expect(writes()).toHaveLength(0);
  });
});

describe('upload field config', () => {
  const PRIORITY = { fieldId: 'priority', name: 'Priority', required: true, schema: { type: 'priority' }, allowedValues: [{ id: '1', name: 'High' }, { id: '2', name: 'Low' }] };
  const TEAM = { fieldId: 'customfield_20001', name: 'Team', required: false, schema: { type: 'string' } };
  const WEIRD = { fieldId: 'customfield_30', name: 'Weird', required: true, schema: { type: 'weird' } };
  const cfgOf = async (pid: number) => (await api('GET', `/api/projects/${pid}`)).body.jiraUploadConfig;
  const form = (pid: number, iid: number) => api('GET', `/api/issues/${iid}/jira/upload-form?project=${pid}`);
  const post = (pid: number, iid: number, payload: any) => api('POST', `/api/issues/${iid}/jira/upload?project=${pid}`, payload);
  beforeEach(() => env());

  it('round-trips, null clears, omitted keeps, invalid is 400', async () => {
    stub();
    const p = await project();
    expect(p.jiraUploadConfig).toEqual({ hidden: [], defaults: {} });
    const c = { hidden: ['a', 'a', 'b'], defaults: { a: 'x', n: 3, l: ['1', 2] } };
    const r = await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: c });
    expect(r.body.jiraUploadConfig).toEqual({ hidden: ['a', 'b'], defaults: c.defaults });
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name })).body.jiraUploadConfig.hidden).toEqual(['a', 'b']);
    expect((await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: null })).body.jiraUploadConfig).toEqual({ hidden: [], defaults: {} });
    for (const bad of ['x', [], { hidden: 'a' }, { hidden: [''] }, { hidden: [1] }, { defaults: [] }, { defaults: { a: {} } }, { defaults: { a: [{}] } }, { defaults: { '': 'x' } }, { hidden: Array.from({ length: 201 }, (_, i) => `f${i}`) }]) {
      const e = await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: bad });
      expect(e.status).toBe(400); expect(e.body.error.code).toBe('validation_error');
    }
    expect(await cfgOf(p.id)).toEqual({ hidden: [], defaults: {} });
  });

  it('is never exported or imported', async () => {
    stub();
    const p = await project({ jiraUploadConfig: undefined });
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: { hidden: ['a'], defaults: {} } });
    const file = (await api('GET', `/api/projects/${p.id}/export`)).body;
    expect(JSON.stringify(file)).not.toMatch(/jiraUploadConfig|jira_upload_config/);
    file.project.jiraUploadConfig = { hidden: ['z'], defaults: {} };
    const imp = await api('POST', '/api/projects/import', file);
    expect(await cfgOf(imp.body.id ?? imp.body.project?.id)).toEqual({ hidden: [], defaults: {} });
  });

  it('upload-form marks defaults and hidden, dropping stale ones and keeping unusable-hide fields visible', async () => {
    stub({ meta: [PRIORITY, TEAM, WEIRD] });
    const p = await project(); const t = await mk(p.id, 'story', 'S');
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: { hidden: ['priority', 'customfield_20001', 'customfield_30', 'gone'], defaults: { priority: '9', customfield_20001: 'core', customfield_30: 'x', gone: 'y' } } });
    const f = (await form(p.id, t.id)).body.fields;
    const by = (id: string) => f.find((x: any) => x.id === id);
    expect(by('priority').default).toBeUndefined(); expect(by('priority').hidden).toBeUndefined();
    expect(by('customfield_20001')).toMatchObject({ default: 'core', hidden: true });
    expect(by('customfield_30').hidden).toBeUndefined();
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: { hidden: ['priority'], defaults: { priority: '2' } } });
    expect((await form(p.id, t.id)).body.fields[0]).toMatchObject({ default: '2', hidden: true });
  });

  it('upload sends the default of a hidden field the client left out, and nothing for hidden without default', async () => {
    stub({ meta: [PRIORITY, TEAM] });
    const p = await project(); const t = await mk(p.id, 'story', 'S'); const t2 = await mk(p.id, 'story', 'S2');
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: { hidden: ['priority', 'customfield_20001'], defaults: { priority: '2' } } });
    expect((await post(p.id, t.id, { title: 'S', fields: {} })).status).toBe(200);
    expect(creates()[0].body.fields.priority).toEqual({ id: '2' });
    expect(creates()[0].body.fields.customfield_20001).toBeUndefined();
    await post(p.id, t2.id, { title: 'S2', fields: { priority: '1' } });
    expect(creates()[1].body.fields.priority).toEqual({ id: '1' });
  });

  it('a bodyless upload still sends hidden defaults, and stays bare without such config', async () => {
    stub({ meta: [PRIORITY, TEAM] });
    const p = await project(); const t = await mk(p.id, 'story', 'S'); const t2 = await mk(p.id, 'story', 'S2');
    expect((await post(p.id, t.id)).status).toBe(200);
    expect(creates()[0].body.fields.priority).toBeUndefined();
    await api('PUT', `/api/projects/${p.id}`, { name: p.name, jiraUploadConfig: { hidden: ['priority'], defaults: { priority: '2' } } });
    expect((await post(p.id, t2.id)).status).toBe(200);
    expect(creates()[1].body.fields.priority).toEqual({ id: '2' });
  });

  describe('GET /api/jira/create-fields', () => {
    const get = (pid: number, qs = '') => api('GET', `/api/jira/create-fields?project=${pid}${qs}`);
    it('returns the type, its fields and needs only Jira enabled', async () => {
      env({ JIRA_WRITE: '0' }); stub({ meta: [PRIORITY, TEAM] });
      const p = await project({ jiraWrite: false });
      const r = await get(p.id, '&issueType=Bug');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ project: { ref: '10000', key: 'KEY' }, issueType: { name: 'Bug' } });
      expect(r.body.fields.map((f: any) => f.id)).toEqual(['priority', 'customfield_20001']);
      expect((await get(p.id)).body.issueType.name).toBe('Epic');
      expect(writes()).toHaveLength(0);
    });
    it('409 when disabled, 200 empty without a project id, 400 for a bad type', async () => {
      stub();
      const off = await project({ jiraEnabled: false });
      expect((await get(off.id)).status).toBe(409);
      const none = await project({ jiraProjectId: undefined });
      expect(await get(none.id)).toMatchObject({ status: 200, body: { project: { ref: null }, fields: [] } });
      const p = await project();
      expect((await get(p.id, '&issueType=Nope')).status).toBe(400);
    });
  });
});

describe('review fixes', () => {
  beforeEach(() => { env(); stub(); });
  it('mapState does not treat "Invalid" or "Not valid" as validation', async () => {
    const { mapState } = await import('../src/jiraSync.js');
    expect(mapState('Invalid', 'indeterminate')).toBe('open');
    expect(mapState('Not valid', 'new')).toBe('open');
    expect(mapState('Validating', 'indeterminate')).toBe('test_validation');
    expect(mapState('In Test', 'indeterminate')).toBe('test_validation');
  });

  it('jiraTiming counts a reopen, clears the closer, and never invents a close time', async () => {
    const { jiraTiming } = await import('../src/routes/issues.js');
    const closed = { state: 'closed', closed_at: '2026-01-01 00:00:00', closed_owner_id: 3, reopen_count: 1 };
    expect(jiraTiming(closed, 'open')).toMatchObject({ closedAt: null, closedOwner: null, reopens: 2 });
    expect(jiraTiming(closed, 'closed')).toMatchObject({ closedAt: '2026-01-01 00:00:00', closedOwner: 3, reopens: 1 });
    expect(jiraTiming({ state: 'open', reopen_count: 0 }, 'closed')).toMatchObject({ closedAt: null, closedOwner: null, reopens: 0 });
  });

  it('update compares Jira against the issue\'s own sync time', async () => {
    const p = await project(); const t = await mk(p.id, 'story', 'T');
    await upload(p.id, t.id);
    // Jira is edited after our upload; the update must notice, whatever the project-wide stamp says
    st.existing = { fields: { updated: new Date(Date.now() + 60_000).toISOString().replace('Z', '+0000'), labels: [] } };
    const r = await update(p.id, t.id);
    expect(r.status).toBe(409);
    expect(r.body.error.extra?.jiraUpdated).toBe(true);
  });
});
