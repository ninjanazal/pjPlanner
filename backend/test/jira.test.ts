import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildApp } from '../src/app.js';

let app: ReturnType<typeof buildApp>;
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => { app = buildApp(':memory:'); });
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.JIRA_URL;
  delete process.env.JIRA_TOKEN;
});

const configure = () => { process.env.JIRA_URL = 'https://jira.local/'; process.env.JIRA_TOKEN = 'secret-token'; };

describe('jira config', () => {
  it('reports unconfigured without leaking anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jira/status' });
    expect(res.json()).toEqual({ configured: false, available: false, missing: ['JIRA_URL', 'JIRA_TOKEN'], url: null, writeAllowed: false });
  });

  it('reports the url but never the token', async () => {
    configure();
    const res = await app.inject({ method: 'GET', url: '/api/jira/status' });
    expect(res.json()).toEqual({ configured: true, available: true, missing: [], url: 'https://jira.local', writeAllowed: false });
    expect(res.body).not.toContain('secret-token');
  });

  it('test and preview answer 409 when unconfigured', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/jira/test' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/jira/preview', payload: { jql: 'a = b' } })).statusCode).toBe(409);
  });
});

describe('jira test', () => {
  it('returns version and the bot user, sending the bearer token', async () => {
    configure();
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/serverInfo') ? respond({ version: '10.3.26', deploymentType: 'Server' }) : respond({ name: 'bot', displayName: 'PJ Bot' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.inject({ method: 'POST', url: '/api/jira/test' });
    expect(res.json()).toEqual({ version: '10.3.26', deploymentType: 'Server', user: { name: 'bot', displayName: 'PJ Bot' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://jira.local/rest/api/2/serverInfo');
    expect((fetchMock.mock.calls[0][1] as any).headers.authorization).toBe('Bearer secret-token');
  });

  it('maps a rejected token to jira_error', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => respond({}, 401)));
    const res = await app.inject({ method: 'POST', url: '/api/jira/test' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('jira_error');
    expect(res.body).not.toContain('secret-token');
  });

  it('maps an unreachable host to jira_error', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const res = await app.inject({ method: 'POST', url: '/api/jira/test' });
    expect(res.statusCode).toBe(502);
  });
});


const FIELDS = [
  { id: 'summary', name: 'Summary' },
  { id: 'labels', name: 'Labels' },
  { id: 'customfield_11200', name: 'Project ID', custom: true },
  { id: 'customfield_10301', name: 'Epic Link', custom: true },
  { id: 'customfield_14111', name: 'Parent Link', custom: true },
];
const issue = (key: string, type: string, extra: any = {}) => ({
  key,
  fields: { summary: `${key} title`, description: `${key} desc`, issuetype: { name: type }, status: { name: 'Open', statusCategory: { key: 'new' } }, ...extra },
});
const ISSUES = [
  issue('E-1', 'Epic'),
  issue('S-1', 'Story', { customfield_10301: 'E-1' }),
  issue('T-1', 'Task', { customfield_10301: 'E-1', status: { name: 'Closed', statusCategory: { key: 'done' } } }),
  issue('M-1', 'Milestone'),
  issue('ST-1', 'Sub-Task', { parent: { key: 'S-1' } }),
  issue('MT-1', 'Major Task', { customfield_10301: 'E-1' }),
  issue('ST-2', 'Sub-Task', { parent: { key: 'MT-1' } }), // a task under a task: moves up to the epic
  issue('X-1', 'Task', { customfield_10301: 'OUTSIDE-9' }),
];
let searches: string[] = [];
const stubJira = (issues: any[] = ISSUES) => {
  searches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/rest/api/2/field')) return respond(FIELDS);
    if (url.includes('/rest/api/2/search')) {
      const qs = new URL(url).searchParams;
      searches.push(qs.get('jql')!);
      const at = Number(qs.get('startAt')), n = Number(qs.get('maxResults'));
      return respond({ total: issues.length, issues: issues.slice(at, at + n) });
    }
    return respond({}, 404);
  }));
};
const api = async (method: any, url: string, payload?: any) => {
  const r = await app.inject({ method, url, payload });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

describe('jira preview', () => {
  it('runs the JQL as given and sends the bearer token', async () => {
    configure(); stubJira();
    const r = await api('POST', '/api/jira/preview', { jql: '"Project ID" = RD_230' });
    expect(r.status).toBe(200);
    expect(r.body.jql).toBe('"Project ID" = RD_230');
    expect(searches[0]).toBe('"Project ID" = RD_230');
    expect((((globalThis.fetch as any).mock.calls[0][1]) as any).headers.authorization).toBe('Bearer secret-token');
  });

  it('narrows the JQL to the label, keeping a trailing ORDER BY last', async () => {
    configure(); stubJira();
    expect((await api('POST', '/api/jira/preview', { jql: 'a = b OR c = d ORDER BY key', label: 'pj-track' })).body.jql).toBe('(a = b OR c = d) AND labels = "pj-track" ORDER BY key');
    expect((await api('POST', '/api/jira/preview', { jql: 'a = b', label: 'x' })).body.jql).toBe('(a = b) AND labels = "x"');
    expect((await api('POST', '/api/jira/preview', { label: 'pj-track' })).body.jql).toBe('labels = "pj-track"');
    expect(searches.at(-1)).toBe('labels = "pj-track"');
  });

  it('rejects a missing or empty JQL and a bad label', async () => {
    configure(); stubJira();
    expect((await api('POST', '/api/jira/preview', {})).status).toBe(400);
    expect((await api('POST', '/api/jira/preview', { label: 'two words' })).status).toBe(400);
    expect((await api('POST', '/api/jira/preview', { jql: 'a = b', label: '  ' })).status).toBe(400);
    expect((await api('POST', '/api/jira/preview', { jql: '   ' })).status).toBe(400);
    expect((await api('POST', '/api/jira/preview', { jql: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('relays Jira\'s own message for bad JQL', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/field') ? respond(FIELDS) : respond({ errorMessages: ['Field \'nope\' does not exist'] }, 400)));
    const r = await api('POST', '/api/jira/preview', { jql: 'nope = 1' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("Field 'nope' does not exist");
  });

  it('maps a rejected token to jira_error', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => respond({}, 401)));
    expect((await api('POST', '/api/jira/preview', { jql: 'a = b' })).status).toBe(502);
  });

  it('previews counts, skipped types and a sample without writing', async () => {
    configure(); stubJira();
    const r = await api('POST', '/api/jira/preview', { jql: 'x = y' });
    expect(r.body.total).toBe(8);
    expect(r.body.importable).toBe(7);
    expect(r.body.skipped).toEqual({ Milestone: 1 });
    expect(r.body.byType.Task).toBe(2);
    expect(r.body.sample[0]).toMatchObject({ key: 'E-1', type: 'epic' });
    await api('POST', '/api/projects', { name: 'P' });
    expect((await api('GET', '/api/issues')).body).toEqual([]);
  });

  it('refuses a filter matching more than the limit', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/field') ? respond(FIELDS) : respond({ total: 5000, issues: [] })));
    const r = await api('POST', '/api/jira/preview', { jql: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('5000');
  });
});

describe('project jira filter', () => {
  it('is stored on the project, omitted = unchanged, null = clear', async () => {
    const p = (await api('POST', '/api/projects', { name: 'P', jiraJql: ' "Project ID" = RD_230 ' })).body;
    expect(p.jiraJql).toBe('"Project ID" = RD_230');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P2' })).body.jiraJql).toBe('"Project ID" = RD_230');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P2', jiraJql: 'a = b' })).body.jiraJql).toBe('a = b');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P2', jiraJql: null })).body.jiraJql).toBeNull();
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P2', jiraJql: '' })).status).toBe(400);
  });

  it('stores the tracking label the same way and rejects spaces', async () => {
    const p = (await api('POST', '/api/projects', { name: 'P', jiraLabel: ' pj-track ' })).body;
    expect(p.jiraLabel).toBe('pj-track');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P' })).body.jiraLabel).toBe('pj-track');
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P', jiraLabel: null })).body.jiraLabel).toBeNull();
    expect((await api('PUT', `/api/projects/${p.id}`, { name: 'P', jiraLabel: 'a b' })).status).toBe(400);
  });
});

describe('jira import', () => {
  const setup = async () => {
    configure(); stubJira();
    const p = (await api('POST', '/api/projects', { name: 'P', jiraEnabled: true, jiraJql: 'cf[11200] = "RD_230"' })).body;
    const run = () => api('POST', `/api/projects/${p.id}/jira/import`);
    const issues = async () => (await api('GET', `/api/issues?project=${p.id}`)).body as any[];
    return { p, run, issues };
  };

  it('needs a filter and a configured Jira', async () => {
    const p = (await api('POST', '/api/projects', { name: 'P', jiraEnabled: true })).body;
    expect((await api('POST', `/api/projects/${p.id}/jira/import`)).status).toBe(400);
    const q = (await api('POST', '/api/projects', { name: 'Q', jiraEnabled: true, jiraJql: 'a = b' })).body;
    expect((await api('POST', `/api/projects/${q.id}/jira/import`)).status).toBe(409);
    expect((await api('POST', '/api/projects/999/jira/import')).status).toBe(404);
  });

  it('imports with only a label (no JQL), and combines it with the JQL', async () => {
    configure(); stubJira();
    const a = (await api('POST', '/api/projects', { name: 'L', jiraEnabled: true, jiraLabel: 'pj-track' })).body;
    expect((await api('POST', `/api/projects/${a.id}/jira/import`)).body.jql).toBe('labels = "pj-track"');
    const b = (await api('POST', '/api/projects', { name: 'M', jiraEnabled: true, jiraJql: 'x = 1', jiraLabel: 'pj-track' })).body;
    expect((await api('POST', `/api/projects/${b.id}/jira/import`)).body.jql).toBe('(x = 1) AND labels = "pj-track"');
  });

  it('creates issues with types, state, jira key and parents', async () => {
    const { p, run, issues } = await setup();
    expect((await api('GET', `/api/projects/${p.id}`)).body.jiraSyncedAt).toBeNull();
    const r = await run();
    expect(r.status).toBe(200);
    expect((await api('GET', `/api/projects/${p.id}`)).body.jiraSyncedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(r.body).toMatchObject({ created: 7, updated: 0, skipped: { Milestone: 1 }, notInFilter: 0, jql: 'cf[11200] = "RD_230"' });
    const list = await issues();
    const by = (k: string) => list.find((i) => i.jiraKey === k);
    expect(list.map((i) => [i.jiraKey, i.type, i.state])).toEqual([
      ['E-1', 'epic', 'open'], ['S-1', 'story', 'open'], ['T-1', 'task', 'closed'], ['ST-1', 'task', 'open'],
      ['MT-1', 'task', 'open'], ['ST-2', 'task', 'open'], ['X-1', 'task', 'open'],
    ]);
    expect(by('S-1').parentId).toBe(by('E-1').id);
    expect(by('T-1').parentId).toBe(by('E-1').id);
    expect(by('ST-1').parentId).toBe(by('S-1').id);
    expect(by('MT-1').parentId).toBe(by('E-1').id);
    expect(by('ST-2').parentId).toBe(by('E-1').id); // task under a task moved up to the epic
    expect(by('X-1').parentId).toBeNull(); // parent is outside the filter
    expect(by('E-1').title).toBe('E-1 title');
    expect(by('E-1').description).toBe('E-1 desc');
  });

  it('maps Jira statuses to the review stages', async () => {
    configure();
    const st = (name: string, cat = 'indeterminate') => ({ status: { name, statusCategory: { key: cat } } });
    stubJira([issue('A-1', 'Task', st('Waiting Code Review')), issue('A-2', 'Task', st('Validating')), issue('A-3', 'Task', st('In Test')),
      issue('A-4', 'Task', st('Closed', 'done')), issue('A-5', 'Task', st('In Progress')), issue('A-6', 'Task', st('Done Review', 'done'))]);
    const p = (await api('POST', '/api/projects', { name: 'S', jiraEnabled: true, jiraJql: 'x = y' })).body;
    await api('POST', `/api/projects/${p.id}/jira/import`);
    const list = (await api('GET', `/api/issues?project=${p.id}`)).body as any[];
    expect(list.map((i) => [i.jiraKey, i.state])).toEqual([
      ['A-1', 'code_review'], ['A-2', 'test_validation'], ['A-3', 'test_validation'], ['A-4', 'closed'], ['A-5', 'open'], ['A-6', 'closed'],
    ]);
  });

  it('re-links a project imported from a file (no keys) by type and title instead of duplicating', async () => {
    const { p, run } = await setup();
    await run();
    const file = (await api('GET', `/api/projects/${p.id}/export`)).body;
    const q = (await api('POST', '/api/projects/import', file)).body;
    await api('PUT', `/api/projects/${q.id}`, { name: q.name, jiraEnabled: true, jiraJql: 'cf[11200] = "RD_230"' });
    const r = await api('POST', `/api/projects/${q.id}/jira/import`);
    expect(r.body).toMatchObject({ created: 0, updated: 0, linked: 7 });
    const list = (await api('GET', `/api/issues?project=${q.id}`)).body;
    expect(list).toHaveLength(7);
    expect(list.every((i: any) => i.jiraKey)).toBe(true);
  });

  it('is idempotent, follows Jira, and keeps pjPlanner-only fields', async () => {
    const { p, run, issues } = await setup();
    await run();
    const task = (await issues()).find((i) => i.jiraKey === 'X-1');
    const o = (await api('POST', `/api/owners?project=${p.id}`, { name: 'Ann' })).body;
    const m = (await api('POST', `/api/modules?project=${p.id}`, { name: 'Mod', ownerIds: [o.id] })).body;
    await api('PUT', `/api/issues/${task.id}?project=${p.id}`, { ...task, moduleId: m.id, ownerId: o.id, estimate: 5 });
    stubJira(ISSUES.map((i) => i.key === 'X-1' ? { ...i, fields: { ...i.fields, summary: 'renamed', status: { statusCategory: { key: 'done' } } } } : i));
    const r = await run();
    expect(r.body).toMatchObject({ created: 0, updated: 7 });
    const list = await issues();
    expect(list).toHaveLength(7);
    expect(list.find((i) => i.jiraKey === 'X-1')).toMatchObject({ title: 'renamed', state: 'closed', moduleId: m.id, ownerId: o.id, estimate: 5 });
  });

  it('reports issues no longer matching the filter and leaves them alone', async () => {
    const { run, issues } = await setup();
    await run();
    stubJira(ISSUES.slice(0, 2));
    const r = await run();
    expect(r.body).toMatchObject({ created: 0, updated: 2, notInFilter: 5 });
    expect(await issues()).toHaveLength(7);
  });

  it('never leaks the token', async () => {
    const { run } = await setup();
    expect(JSON.stringify((await run()).body)).not.toContain('secret-token');
  });
});

describe('planImport issue links', () => {
  it('parents a task under the story it is linked to', async () => {
    const { planImport } = await import('../src/jiraSync.js');
    const mk = (key: string, type: string, extra: Record<string, unknown> = {}) =>
      ({ key, fields: { summary: key, issuetype: { name: type }, status: { name: 'To Do' }, ...extra } });
    const plan = planImport(
      [mk('A-1', 'Story'), mk('A-2', 'Task', { issuelinks: [{ outwardIssue: { key: 'A-1' } }] }), mk('A-3', 'Task', { issuelinks: [{ inwardIssue: { key: 'A-2' } }] })],
      { epicLink: null, parentLink: null, epicName: null },
    );
    expect(plan.issues.map((i) => i.parentKey)).toEqual([null, 'A-1', null]);
  });
});
