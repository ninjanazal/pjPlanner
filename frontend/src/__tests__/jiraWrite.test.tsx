import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssuePage } from '../components/IssuePage';
import { IntegrationsDialog } from '../components/IntegrationsDialog';
import { ToastProvider } from '../components/Toast';
import type { Issue, Project } from '../types';

const issue = (id: number, extra: Partial<Issue> = {}): Issue => ({
  id, type: 'story', title: `Issue ${id}`, description: '', implementation: '', createdAt: '', startedAt: null, closedAt: null, closedOwnerId: null, reopenCount: 0, updatedAt: '',
  parentId: null, ownerId: null, moduleId: null, sprintId: null, state: 'open', childIds: [], rollupModuleIds: [], ...extra,
} as Issue);
const project = (extra: Partial<Project> = {}): Project => ({ id: 1, name: 'Alpha', description: '', createdAt: '', moduleCount: 0, issueCount: 0, sprintCount: 0, jiraWrite: true, jiraEnabled: true, jiraProjectId: '10000', ...extra });

const mockStatus = (writeAllowed: boolean) => {
  const f = vi.fn(async (url: string, init: any = {}) => {
    if (url === '/api/jira/status') return { status: 200, ok: true, json: async () => ({ configured: true, url: 'https://j', writeAllowed }) };
    return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found', message: 'x' } }) };
  });
  vi.stubGlobal('fetch', f);
};
afterEach(() => vi.unstubAllGlobals());

const show = (i: Issue, all: Issue[], p: Project | null) =>
  render(<IssuePage issue={i} issues={all} sprints={[]} modules={[]} owners={[]} onChanged={vi.fn()} project={p} />);

describe('Jira write buttons', () => {
  it('offers Upload for an unlinked top-level issue', async () => {
    mockStatus(true);
    const i = issue(1);
    show(i, [i], project());
    expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update in Jira' })).toBeNull();
  });

  it('offers Upload for a root issue even when the project has no Jira project id', async () => {
    mockStatus(true);
    const i = issue(1);
    show(i, [i], project({ jiraProjectId: null }));
    expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
  });

  it('offers Update, not Upload, for a linked issue', async () => {
    mockStatus(true);
    const i = issue(1, { jiraKey: 'PJ-1' });
    show(i, [i], project());
    expect(await screen.findByRole('button', { name: 'Update in Jira' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload to Jira' })).toBeNull();
  });

  it('hides Upload while the parent is not in Jira, shows it once the parent is', async () => {
    mockStatus(true);
    const epic = issue(1, { type: 'epic' });
    const child = issue(2, { type: 'story', parentId: 1 });
    const { unmount } = show(child, [epic, child], project());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Upload to Jira' })).toBeNull());
    unmount();
    const linked = { ...epic, jiraKey: 'PJ-9' };
    show(child, [linked, child], project());
    expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
  });

  it('shows Upload for a root task and a root epic, and for a task under a Jira parent', async () => {
    mockStatus(true);
    const task = issue(1, { type: 'task' });
    const a = show(task, [task], project());
    expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
    a.unmount();
    const epic = issue(1, { type: 'epic' });
    const b = show(epic, [epic], project());
    expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
    b.unmount();
    for (const type of ['epic', 'story', 'bug'] as const) {
      const parent = issue(1, { type, jiraKey: 'PJ-9' }); const child = issue(2, { type: 'task', parentId: 1 });
      const c = show(child, [parent, child], project());
      expect(await screen.findByRole('button', { name: 'Upload to Jira' })).toBeInTheDocument();
      c.unmount();
    }
  });

  it('hides both when the project does not allow writing', async () => {
    mockStatus(true);
    const i = issue(1);
    show(i, [i], project({ jiraWrite: false }));
    await userEvent.setup().tab();
    expect(screen.queryByRole('button', { name: 'Upload to Jira' })).toBeNull();
  });

  it('hides both and never asks Jira for its status when Jira is disabled for the project', async () => {
    mockStatus(true);
    const i = issue(1);
    show(i, [i], project({ jiraEnabled: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Upload to Jira' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hides both when the server does not allow writing', async () => {
    mockStatus(false);
    const i = issue(1);
    show(i, [i], project());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Upload to Jira' })).toBeNull();
  });
});

type Reply = { status?: number; body: unknown };
// Routes fetch by "METHOD /path"; Jira status always allows writing unless overridden.
const mockRoutes = (routes: Record<string, (body: any) => Reply>, status: Record<string, unknown> = {}) => {
  const f = vi.fn(async (url: string, init: any = {}) => {
    if (url === '/api/jira/status') return { status: 200, ok: true, json: async () => ({ configured: true, url: 'https://j', writeAllowed: true, ...status }) };
    const h = routes[`${init.method ?? 'GET'} ${url}`];
    if (!h) return { status: 404, ok: false, json: async () => ({ error: { code: 'not_found', message: 'no mock' } }) };
    const r = h(init.body ? JSON.parse(init.body) : undefined);
    const st = r.status ?? 200;
    return { status: st, ok: st < 400, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f);
  return f;
};
const calls = (f: ReturnType<typeof vi.fn>, key: string) =>
  f.mock.calls.filter(([u, i]: any[]) => `${i?.method ?? 'GET'} ${u}` === key);
const showToasted = (i: Issue, onChanged = vi.fn()) => {
  render(<ToastProvider><IssuePage issue={i} issues={[i]} sprints={[]} modules={[]} owners={[]} onChanged={onChanged} project={project()} /></ToastProvider>);
  return onChanged;
};
const dialog = () => screen.findByRole('alertdialog');

describe('Jira write actions', () => {
  const form = { project: { ref: '10000', key: 'PJ', name: 'Proj', locked: false }, issueTypes: [{ id: '1', name: 'Story', subtask: false }], issueType: { id: '1', name: 'Story' },
    values: { title: 'Issue 1', description: '', labels: [] }, link: { kind: 'none', label: 'Top-level issue' }, match: null, fields: [] };

  it('opens the upload form, creates from it and toasts the new key', async () => {
    const f = mockRoutes({
      'GET /api/issues/1/jira/upload-form': () => ({ body: form }),
      'POST /api/issues/1/jira/upload': () => ({ body: { issue: { jiraKey: 'PJ-7' }, adopted: false } }),
    });
    const onChanged = showToasted(issue(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Upload to Jira' }));
    expect(calls(f, 'POST /api/issues/1/jira/upload')).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Create in Jira' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Uploaded to Jira as PJ-7');
    expect(calls(f, 'POST /api/issues/1/jira/upload')).toHaveLength(1);
    expect(onChanged).toHaveBeenCalled();
  });

  it('does not upload when the form is cancelled', async () => {
    const f = mockRoutes({ 'GET /api/issues/1/jira/upload-form': () => ({ body: form }), 'POST /api/issues/1/jira/upload': () => ({ body: { issue: { jiraKey: 'PJ-7' } } }) });
    showToasted(issue(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Upload to Jira' }));
    await screen.findByRole('button', { name: 'Create in Jira' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls(f, 'POST /api/issues/1/jira/upload')).toHaveLength(0);
  });

  it('updates after confirming, without force', async () => {
    const f = mockRoutes({ 'POST /api/issues/1/jira/update': () => ({ body: { issue: { jiraKey: 'PJ-1' } } }) });
    showToasted(issue(1, { jiraKey: 'PJ-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update in Jira' }));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Update' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Updated in Jira');
    const c = calls(f, 'POST /api/issues/1/jira/update');
    expect(c).toHaveLength(1);
    expect(JSON.parse(c[0][1].body)).toEqual({});
  });

  const conflict = { status: 409, body: { error: { code: 'conflict', message: 'changed', extra: { jiraUpdated: '2026-01-01' } } } };

  it('asks to overwrite on a Jira edit conflict and retries with force', async () => {
    const f = mockRoutes({ 'POST /api/issues/1/jira/update': (b) => (b?.force ? { body: { issue: { jiraKey: 'PJ-1' } } } : conflict) });
    showToasted(issue(1, { jiraKey: 'PJ-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update in Jira' }));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Update' }));
    const second = await screen.findByRole('alertdialog', { name: /Jira changed since the last sync/ });
    await userEvent.click(within(second).getByRole('button', { name: 'Overwrite' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Updated in Jira');
    const c = calls(f, 'POST /api/issues/1/jira/update');
    expect(c.map(([, i]: any[]) => JSON.parse(i.body))).toEqual([{}, { force: true }]);
  });

  it('does not retry when the overwrite is declined', async () => {
    const f = mockRoutes({ 'POST /api/issues/1/jira/update': () => conflict });
    showToasted(issue(1, { jiraKey: 'PJ-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update in Jira' }));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Update' }));
    const second = await screen.findByRole('alertdialog', { name: /Jira changed since the last sync/ });
    await userEvent.click(within(second).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls(f, 'POST /api/issues/1/jira/update')).toHaveLength(1);
  });

  it('shows an error toast, and no overwrite prompt, for other failures', async () => {
    mockRoutes({ 'POST /api/issues/1/jira/update': () => ({ status: 502, body: { error: { code: 'jira_error', message: 'Jira is down' } } }) });
    showToasted(issue(1, { jiraKey: 'PJ-1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Update in Jira' }));
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Update' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jira is down');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('IntegrationsDialog write setting', () => {
  const setup = (p: Project) => {
    const props = { project: p, onChanged: vi.fn(), onImported: vi.fn(), onClose: vi.fn() };
    render(<IntegrationsDialog {...props} />);
    return props;
  };

  it('saves jiraWrite when the checkbox is toggled', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    const props = setup(project({ jiraWrite: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const box = await screen.findByRole('checkbox', { name: 'Allow writing to Jira' });
    expect(box).not.toBeChecked();
    expect(box).toBeEnabled();
    await userEvent.click(box);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    const c = calls(f, 'PUT /api/projects/1');
    expect(JSON.parse(c[0][1].body)).toEqual({ name: 'Alpha', jiraWrite: true });
  });

  it('turns writing off from the checked state', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    setup(project({ jiraWrite: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const box = await screen.findByRole('checkbox', { name: 'Allow writing to Jira' });
    expect(box).toBeChecked();
    expect(screen.getByText('read and write')).toBeInTheDocument();
    await userEvent.click(box);
    await waitFor(() => expect(calls(f, 'PUT /api/projects/1')).toHaveLength(1));
    expect(JSON.parse(calls(f, 'PUT /api/projects/1')[0][1].body)).toEqual({ name: 'Alpha', jiraWrite: false });
  });

  it('is disabled with a hint when the server does not allow writing', async () => {
    const f = mockRoutes({}, { writeAllowed: false });
    setup(project({ jiraWrite: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const box = await screen.findByRole('checkbox', { name: 'Allow writing to Jira' });
    expect(box).toBeDisabled();
    expect(screen.getByText(/JIRA_WRITE=1/)).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
        await userEvent.click(box);
    expect(calls(f, 'PUT /api/projects/1')).toHaveLength(0);
  });

  it('saves the Jira project id from its input, and clears it when emptied', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    setup(project({ jiraProjectId: null }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const input = await screen.findByRole('textbox', { name: 'Jira project id' });
    expect(input).toHaveValue('');
    await userEvent.type(input, '10050');
    await userEvent.click(screen.getByRole('button', { name: 'Save project id' }));
    await waitFor(() => expect(calls(f, 'PUT /api/projects/1')).toHaveLength(1));
    expect(JSON.parse(calls(f, 'PUT /api/projects/1')[0][1].body)).toEqual({ name: 'Alpha', jiraProjectId: '10050' });
    expect(screen.queryByText(/JIRA_PROJECT_KEY/)).toBeNull();
  });

  it('sends null when the saved project id is emptied', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    setup(project({ jiraProjectId: '10000' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const input = await screen.findByRole('textbox', { name: 'Jira project id' });
    expect(input).toHaveValue('10000');
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole('button', { name: 'Save project id' }));
    await waitFor(() => expect(calls(f, 'PUT /api/projects/1')).toHaveLength(1));
    expect(JSON.parse(calls(f, 'PUT /api/projects/1')[0][1].body)).toEqual({ name: 'Alpha', jiraProjectId: null });
  });
});

describe('IntegrationsDialog enable switch', () => {
  const setup = (p: Project) => {
    const props = { project: p, onChanged: vi.fn(), onImported: vi.fn(), onClose: vi.fn() };
    render(<IntegrationsDialog {...props} />);
    return props;
  };

  it('is unavailable, naming what is missing, with the switch disabled and no settings', async () => {
    mockRoutes({}, { configured: false, available: false, missing: ['JIRA_URL', 'JIRA_TOKEN'], url: null });
    setup(project({ jiraEnabled: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Missing: JIRA_URL, JIRA_TOKEN in/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enable Jira' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: 'Allow writing to Jira' })).toBeNull();
  });

  it('lists only the one missing item', async () => {
    mockRoutes({}, { configured: false, available: false, missing: ['JIRA_TOKEN'], url: null });
    setup(project());
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    expect(await screen.findByText(/Missing: JIRA_TOKEN in/)).toBeInTheDocument();
  });

  it('enabling saves jiraEnabled', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    const props = setup(project({ jiraEnabled: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    const sw = await screen.findByRole('checkbox', { name: 'Enable Jira' });
    expect(sw).toBeEnabled();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(JSON.parse(calls(f, 'PUT /api/projects/1')[0][1].body)).toEqual({ name: 'Alpha', jiraEnabled: true });
  });

  it('disabling saves jiraEnabled false', async () => {
    const f = mockRoutes({ 'PUT /api/projects/1': (b) => ({ body: { ...project(), ...b } }) });
    setup(project({ jiraEnabled: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Enable Jira' }));
    await waitFor(() => expect(calls(f, 'PUT /api/projects/1')).toHaveLength(1));
    expect(JSON.parse(calls(f, 'PUT /api/projects/1')[0][1].body)).toEqual({ name: 'Alpha', jiraEnabled: false });
  });

  it('keeps the write checkbox and other settings disabled while Jira is disabled', async () => {
    mockRoutes({});
    setup(project({ jiraEnabled: false, jiraWrite: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    expect(await screen.findByRole('checkbox', { name: 'Allow writing to Jira' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'JQL' })).toBeDisabled();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('shows the write checkbox enabled once Jira is enabled', async () => {
    mockRoutes({});
    setup(project({ jiraEnabled: true, jiraWrite: false }));
    await userEvent.click(await screen.findByRole('button', { name: 'Jira' }));
    expect(await screen.findByRole('checkbox', { name: 'Allow writing to Jira' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'JQL' })).toBeEnabled();
  });
});

describe('Refresh from Jira', () => {
  const btn = () => screen.findByRole('button', { name: 'Refresh from Jira' });
  const showWith = (i: Issue, p: Project, onChanged = vi.fn()) => {
    render(<ToastProvider><IssuePage issue={i} issues={[i]} sprints={[]} modules={[]} owners={[]} onChanged={onChanged} project={p} /></ToastProvider>);
    return onChanged;
  };

  it('is shown only for a linked issue in a Jira-enabled project, without asking Jira for its status', async () => {
    const f = mockRoutes({});
    showWith(issue(1, { jiraKey: 'PJ-1' }), project({ jiraWrite: false }));
    expect(await btn()).toBeEnabled();
    expect(calls(f, 'GET /api/jira/status')).toHaveLength(0);
  });

  it('is hidden when the issue is not linked or Jira is disabled', async () => {
    mockRoutes({});
    const { unmount } = render(<ToastProvider><IssuePage issue={issue(1)} issues={[]} sprints={[]} modules={[]} owners={[]} onChanged={vi.fn()} project={project()} /></ToastProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Refresh from Jira' })).toBeNull();
    unmount();
    showWith(issue(1, { jiraKey: 'PJ-1' }), project({ jiraEnabled: false }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Refresh from Jira' })).toBeNull();
  });

  it('posts after confirming, then reloads and toasts', async () => {
    const f = mockRoutes({ 'POST /api/issues/1/jira/refresh': () => ({ body: { issue: { jiraKey: 'PJ-1' } } }) });
    const onChanged = showWith(issue(1, { jiraKey: 'PJ-1' }), project());
    await userEvent.click(await btn());
    expect(calls(f, 'POST /api/issues/1/jira/refresh')).toHaveLength(0);
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Refreshed from Jira');
    expect(calls(f, 'POST /api/issues/1/jira/refresh')).toHaveLength(1);
    expect(onChanged).toHaveBeenCalled();
  });

  it('posts nothing when cancelled', async () => {
    const f = mockRoutes({ 'POST /api/issues/1/jira/refresh': () => ({ body: { issue: {} } }) });
    showWith(issue(1, { jiraKey: 'PJ-1' }), project());
    await userEvent.click(await btn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls(f, 'POST /api/issues/1/jira/refresh')).toHaveLength(0);
  });

  it('shows an error toast on failure', async () => {
    mockRoutes({ 'POST /api/issues/1/jira/refresh': () => ({ status: 404, body: { error: { code: 'not_found', message: 'Not found in Jira' } } }) });
    showWith(issue(1, { jiraKey: 'PJ-1' }), project());
    await userEvent.click(await btn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found in Jira');
  });

  it('is disabled while the draft has unsaved edits', async () => {
    mockRoutes({});
    showWith(issue(1, { jiraKey: 'PJ-1' }), project());
    const b = await btn();
    expect(b).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Title'), ' more');
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('title', 'Save your changes first');
  });
});
