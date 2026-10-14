import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntegrationsDialog, ago } from '../components/IntegrationsDialog';
import { IssuesPage, JiraUrlContext } from '../components/IssuesPage';
import { INTEGRATIONS } from '../integrations';
import { setProjectId } from '../api';
import type { Issue, Project } from '../types';

const project = (extra: Partial<Project> = {}): Project => ({ id: 1, name: 'Alpha', description: '', createdAt: '', moduleCount: 0, issueCount: 0, sprintCount: 0, jiraJql: null, jiraEnabled: true, ...extra });

type Handler = (body: any) => { status?: number; body: unknown };
// Routes the fetch mock by "METHOD /path".
const mockApi = (routes: Record<string, Handler>) => {
  const f = vi.fn(async (url: string, init: any = {}) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const h = routes[key];
    if (!h) return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found', message: `no mock for ${key}` } }) };
    const r = h(init.body ? JSON.parse(init.body) : undefined);
    const status = r.status ?? 200;
    return { status, ok: status < 400, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f);
  return f;
};
const configured = { 'GET /api/jira/status': () => ({ body: { configured: true, url: 'https://jira.local' } }) };
afterEach(() => { vi.unstubAllGlobals(); setProjectId(null); });

const setup = (p: Project | null = project(), extra: Record<string, any> = {}) => {
  const props = { project: p, onChanged: vi.fn(), onImported: vi.fn(), onClose: vi.fn() };
  render(<IntegrationsDialog {...props} {...extra} />);
  return props;
};
const openJira = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Jira' })); };

describe('IntegrationsDialog', () => {
  it('explains how to turn Jira on when it is not configured', async () => {
    mockApi({ 'GET /api/jira/status': () => ({ body: { configured: false, url: null } }) });
    setup();
    await openJira();
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/JIRA_TOKEN/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Jira filter')).toBeNull();
  });

  it('tests the connection', async () => {
    mockApi({ ...configured, 'POST /api/jira/test': () => ({ body: { version: '10.3.26', deploymentType: 'Server', user: { name: 'bot', displayName: 'PJ Bot' } } }) });
    setup();
    await openJira();
    await screen.findByText('https://jira.local');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent('Connected as PJ Bot · Jira 10.3.26 (Server)');
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('previews the JQL without saving', async () => {
    const f = mockApi({
      ...configured,
      'POST /api/jira/preview': () => ({ body: { jql: '"Project ID" = RD_230', total: 3, importable: 2, byType: { Story: 2, Milestone: 1 }, skipped: { Milestone: 1 }, sample: [{ key: 'A-1', type: 'story', title: 'First', state: 'open', parentKey: null }] } }),
    });
    setup();
    await openJira();
    await screen.findByLabelText('JQL');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('JQL'), '"Project ID" = RD_230');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const box = await screen.findByLabelText('Preview');
    expect(box).toHaveTextContent(/3match2importable1skipped/);
    expect(box).toHaveTextContent('Skipped (no matching issue type): Milestone 1');
    expect(screen.getByText('A-1')).toBeInTheDocument();
    const call = f.mock.calls.find((c) => c[0] === '/api/jira/preview')!;
    expect(JSON.parse(call[1].body)).toEqual({ jql: '"Project ID" = RD_230' });
    await userEvent.type(screen.getByLabelText('Tracking label'), 'pj-track');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(f.mock.calls.filter((c) => c[0] === '/api/jira/preview')).toHaveLength(2));
    expect(JSON.parse(f.mock.calls.filter((c) => c[0] === '/api/jira/preview')[1][1].body)).toEqual({ jql: '"Project ID" = RD_230', label: 'pj-track' });
    expect(f.mock.calls.some((c) => (c[1] as any)?.method === 'PUT')).toBe(false);
  });

  it('saves the JQL on the project, and import is only possible once saved', async () => {
    const f = mockApi({ ...configured, 'PUT /api/projects/1': () => ({ body: project() }) });
    const p = setup();
    await openJira();
    await userEvent.type(await screen.findByLabelText('JQL'), 'labels = x');
    expect(screen.getByRole('button', { name: /Import from Jira/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
    const put = f.mock.calls.find((c) => (c[1] as any)?.method === 'PUT')!;
    expect(JSON.parse(put[1].body)).toEqual({ name: 'Alpha', jiraJql: 'labels = x', jiraLabel: null });
  });

  it('shows the saved JQL and imports with it, reporting the result', async () => {
    mockApi({ ...configured, 'POST /api/projects/1/jira/import': () => ({ body: { jql: 'x', total: 5, created: 3, updated: 1, skipped: { Milestone: 1 }, notInFilter: 2 } }) });
    const p = setup(project({ jiraJql: 'labels = x' }));
    await openJira();
    await waitFor(() => expect(screen.getByLabelText('JQL')).toHaveValue('labels = x'));
    expect(screen.getByRole('button', { name: 'Save filter' })).toBeDisabled(); // nothing changed
    await userEvent.click(screen.getByRole('button', { name: /Import from Jira/ }));
    expect(await screen.findByText(/3 new, 1 updated, skipped Milestone 1\. 2 earlier imports no longer match/)).toBeInTheDocument();
    expect(p.onImported).toHaveBeenCalled();
  });

  it('removes the filter', async () => {
    const f = mockApi({ ...configured, 'PUT /api/projects/1': () => ({ body: project() }) });
    setup(project({ jiraJql: 'labels = x' }));
    await openJira();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove filter' }));
    await waitFor(() => expect(f.mock.calls.some((c) => (c[1] as any)?.method === 'PUT')).toBe(true));
    expect(JSON.parse(f.mock.calls.find((c) => (c[1] as any)?.method === 'PUT')![1].body)).toEqual({ name: 'Alpha', jiraJql: null, jiraLabel: null });
    expect(screen.getByLabelText('JQL')).toHaveValue('');
  });
});

describe('sync summary', () => {
  const imp = (id: number, state: Issue['state']): Issue => ({ id, type: 'task', title: `t${id}`, description: '', parentId: null, ownerId: null, state, moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], jiraKey: `A-${id}` });
  const native: Issue = { ...imp(9, 'open'), jiraKey: null };

  it('counts the issues that came from Jira and offers a refresh with the last sync time', async () => {
    mockApi(configured);
    const recent = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    setup(project({ jiraJql: 'x = y', jiraSyncedAt: recent }), { issues: [imp(1, 'open'), imp(2, 'code_review'), imp(3, 'closed'), native] });
    await openJira();
    const card = await screen.findByLabelText('Sync');
    expect(card).toHaveTextContent('3from Jira');
    expect(card).toHaveTextContent('2unfinished');
    expect(card).toHaveTextContent('1closed');
    expect(card).toHaveTextContent('Last synced 5 min ago');
    expect(screen.getByRole('button', { name: /Import from Jira/ })).toBeEnabled();
  });

  it('says it was never synced and offers the first import', async () => {
    mockApi(configured);
    setup(project({ jiraJql: 'x = y' }));
    await openJira();
    expect(await screen.findByText('Not synced yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import from Jira/ })).toBeEnabled();
  });

  it('shows a red failure when the connection test fails', async () => {
    mockApi({ ...configured, 'POST /api/jira/test': () => ({ status: 502, body: { error: { code: 'jira_error', message: 'Jira rejected the token' } } }) });
    setup();
    await openJira();
    await userEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jira rejected the token');
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });
});

describe('hub', () => {
  it('lists Jira as a tile with its status and opens the panel', async () => {
    mockApi(configured);
    setup();
    const tile = await screen.findByRole('button', { name: 'Jira' });
    expect(tile).toHaveAttribute('title', 'Jira: Enabled');
    expect(screen.getByRole('img', { name: 'Enabled' })).toBeInTheDocument();
    expect(screen.queryByLabelText('JQL')).toBeNull();
    await userEvent.click(tile);
    expect(await screen.findByLabelText('JQL')).toBeInTheDocument();
  });

  it('goes back to the grid', async () => {
    mockApi(configured);
    setup();
    await openJira();
    await userEvent.click(await screen.findByRole('button', { name: '← Integrations' }));
    expect(await screen.findByRole('button', { name: 'Jira' })).toBeInTheDocument();
    expect(screen.queryByLabelText('JQL')).toBeNull();
  });

  it('asks before leaving a panel with unsaved edits', async () => {
    mockApi(configured);
    setup();
    await openJira();
    await userEvent.type(await screen.findByLabelText('JQL'), 'x');
    await userEvent.click(screen.getByRole('button', { name: '← Integrations' }));
    expect(screen.getByText('Discard changes?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('JQL')).toHaveValue('x');
    await userEvent.click(screen.getByRole('button', { name: '← Integrations' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('button', { name: 'Jira' })).toBeInTheDocument();
  });

  it('renders every registered integration', async () => {
    mockApi(configured);
    const fake = { id: 'fake', name: 'Fake', icon: <span>F</span>, summary: () => 'Ready', Panel: () => <p>Fake panel</p> };
    INTEGRATIONS.push(fake);
    try {
      setup();
      await userEvent.click(await screen.findByRole('button', { name: 'Fake' }));
      expect(screen.getByText('Fake panel')).toBeInTheDocument();
    } finally { INTEGRATIONS.pop(); }
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('describes UTC timestamps relative to now', () => {
    expect(ago('2026-10-13 11:59:40', now)).toBe('just now');
    expect(ago('2026-10-13 11:30:00', now)).toBe('30 min ago');
    expect(ago('2026-10-13 09:00:00', now)).toBe('3 h ago');
    expect(ago('2026-10-10 12:00:00', now)).toBe('3 d ago');
  });
});

describe('tracking label', () => {
  it('can be saved on its own, without JQL', async () => {
    const f = mockApi({ ...configured, 'PUT /api/projects/1': () => ({ body: project() }) });
    setup();
    await openJira();
    await userEvent.type(await screen.findByLabelText('Tracking label'), 'pj-track');
    await userEvent.click(screen.getByRole('button', { name: 'Save filter' }));
    await waitFor(() => expect(f.mock.calls.some((c) => (c[1] as any)?.method === 'PUT')).toBe(true));
    expect(JSON.parse(f.mock.calls.find((c) => (c[1] as any)?.method === 'PUT')![1].body)).toEqual({ name: 'Alpha', jiraJql: null, jiraLabel: 'pj-track' });
  });

  it('shows the saved label and keeps Import enabled', async () => {
    mockApi(configured);
    setup(project({ jiraLabel: 'pj-track' }));
    await openJira();
    await waitFor(() => expect(screen.getByLabelText('Tracking label')).toHaveValue('pj-track'));
    expect(screen.getByRole('button', { name: /Import from Jira/ })).toBeEnabled();
  });
});

describe('Jira key on issues', () => {
  const issue = (extra: Partial<Issue>): Issue => ({ id: 1, type: 'task', title: 'T', description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...extra });
  it('links the key to Jira when the address is known', () => {
    render(<JiraUrlContext.Provider value="https://jira.local"><IssuesPage issues={[issue({ jiraKey: 'GP-1' })]} modules={[]} owners={[]} onChanged={vi.fn()} /></JiraUrlContext.Provider>);
    expect(screen.getByRole('link', { name: 'GP-1' })).toHaveAttribute('href', 'https://jira.local/browse/GP-1');
  });
  it('shows no chip for a native issue', () => {
    render(<IssuesPage issues={[issue({})]} modules={[]} owners={[]} onChanged={vi.fn()} />);
    expect(screen.queryByTitle(/Jira/)).toBeNull();
  });
});
