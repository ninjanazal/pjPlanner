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
    expect(res.json()).toEqual({ configured: false, url: null });
  });

  it('reports the url but never the token', async () => {
    configure();
    const res = await app.inject({ method: 'GET', url: '/api/jira/status' });
    expect(res.json()).toEqual({ configured: true, url: 'https://jira.local' });
    expect(res.body).not.toContain('secret-token');
  });

  it('test and discover answer 409 when unconfigured', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/jira/test' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/jira/discover', payload: { projectKey: 'PROJ' } })).statusCode).toBe(409);
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

describe('jira discover', () => {
  it('prefills the type map and finds the Epic Link field', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/project/PROJ')
        ? respond({ key: 'PROJ', name: 'Project', issueTypes: [
            { id: '1', name: 'Epic' }, { id: '2', name: 'Story' }, { id: '3', name: 'Bug' }, { id: '4', name: 'Task' }, { id: '5', name: 'Sub-task', subtask: true } ] })
        : respond([{ id: 'summary', name: 'Summary' }, { id: 'customfield_10014', name: 'Epic Link', custom: true }])));
    const res = await app.inject({ method: 'POST', url: '/api/jira/discover', payload: { projectKey: 'PROJ' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.epicLinkField).toBe('customfield_10014');
    expect(body.typeMap).toEqual({ epic: 'Epic', story: 'Story', bug: 'Bug', task: 'Task' });
    expect(body.project).toEqual({ key: 'PROJ', name: 'Project' });
  });

  it('rejects a malformed project key without calling Jira', async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.inject({ method: 'POST', url: '/api/jira/discover', payload: { projectKey: '../x' } });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown Jira project', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => respond({}, 404)));
    const res = await app.inject({ method: 'POST', url: '/api/jira/discover', payload: { projectKey: 'NOPE' } });
    expect(res.statusCode).toBe(404);
  });
});
