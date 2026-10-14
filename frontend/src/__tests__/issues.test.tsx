import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssuesPage } from '../components/IssuesPage';
import type { Issue, Module, Owner } from '../types';

const mod = (id: number, name: string): Module => ({
  id, name, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const modules = [mod(1, 'Auth'), mod(2, 'Billing')];
const owners: Owner[] = [{ id: 1, name: 'Ana', color: '#f80', icon: '🦊' }];
const mk = (p: Partial<Issue> & Pick<Issue, 'id' | 'type' | 'title'>): Issue => ({
  description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});
const issues = [
  mk({ id: 1, type: 'epic', title: 'Launch', ownerId: 1, moduleId: 1 }),
  mk({ id: 2, type: 'bug', title: 'Login', parentId: 1 }),
  mk({ id: 3, type: 'task', title: 'Finished', state: 'closed' }),
];
const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());
const page = (onChanged = () => {}, issueId: number | null = null) => render(<IssuesPage issues={issues} modules={modules} owners={owners} issueId={issueId} onChanged={onChanged} />);

describe('IssuesPage', () => {
  it('shows tree with badges, chips and hides closed by default', async () => {
    page();
    const items = screen.getAllByRole('treeitem');
    expect(items[0]).toHaveTextContent('#1');
    expect(items[0]).toHaveTextContent('Ana');
    expect(within(items[0]).getAllByTestId('module-chip')[0]).toHaveTextContent('Auth');
    expect(screen.getByLabelText('Open issue Login')).toBeInTheDocument();
    expect(within(screen.getByRole('tree')).queryByLabelText('Open issue Finished')).toBeNull();
    expect(screen.getByText('Closed (1)')).toBeInTheDocument(); // closed work is kept, just tucked away
    await userEvent.click(screen.getByLabelText('Hide closed'));
    expect(within(screen.getByRole('tree')).getByLabelText('Open issue Finished')).toBeInTheDocument();
    expect(screen.queryByText('Closed (1)')).toBeNull();
  });

  it('type dropdown shows an icon per type and a story is a plain grouper', async () => {
    const f = mockFetch(201, {});
    const changed = vi.fn();
    page(changed);
    await userEvent.click(screen.getByText('Add issue'));
    const type = screen.getByLabelText('Type');
    expect([...type.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['⚡ epic', '📖 story', '🐞 bug', '✔ task']);
    await userEvent.type(screen.getByLabelText('Title'), 'As a user');
    await userEvent.selectOptions(type, 'story');
    expect(screen.getByLabelText('Parent')).toBeInTheDocument(); // under an epic
    expect(within(screen.getByLabelText('Parent')).getByText(/Launch/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Module')).toBeNull();
    expect(screen.queryByLabelText('Sprint')).toBeNull();
    await userEvent.click(screen.getByText('Create issue'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'story', title: 'As a user', ownerId: null, moduleId: null });
  });

  it('creates an issue with a single module and filters parents by type', async () => {
    const f = mockFetch(201, {});
    const changed = vi.fn();
    page(changed);
    await userEvent.click(screen.getByText('Add issue'));
    await userEvent.type(screen.getByLabelText('Title'), 'Sub');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'task');
    expect(within(screen.getByLabelText('Parent')).getByText(/Launch/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'epic');
    expect(screen.queryByLabelText('Parent')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'task');
    expect(within(screen.getByLabelText('Parent')).getByText(/Login/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Parent'), '2');
    await userEvent.type(screen.getByLabelText('Module'), 'bll');
    await userEvent.click(screen.getByRole('option', { name: /Billing/ }));
    await userEvent.click(screen.getByText('Create issue'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/issues');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'task', title: 'Sub', parentId: 2, moduleId: 2, ownerId: null, state: 'open' });
  });

  it('will not create a task until it has a module', async () => {
    const f = mockFetch(201, {});
    page();
    await userEvent.click(screen.getByText('Add issue'));
    await userEvent.type(screen.getByLabelText('Title'), 'No module yet');
    expect(screen.getByText('Create issue')).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Module'));
    await userEvent.click(screen.getByRole('option', { name: /Auth/ }));
    expect(screen.getByText('Create issue')).toBeEnabled();
    await userEvent.click(screen.getByText('Create issue'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'task', moduleId: 1 });
  });

  it('closes an issue in one click, keeping the rest of it', async () => {
    const f = mockFetch(200, {});
    const changed = vi.fn();
    page(changed);
    await userEvent.click(screen.getByLabelText('Close issue Login'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/issues/2');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'bug', title: 'Login', parentId: 1, state: 'closed' });
  });

  it('shows server errors inline', async () => {
    mockFetch(400, { error: { code: 'invalid', message: 'Bad parent' } });
    page();
    await userEvent.click(screen.getByText('Add issue'));
    await userEvent.type(screen.getByLabelText('Title'), 'x');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'story');
    await userEvent.click(screen.getByText('Create issue'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad parent');
  });

  it('delete confirmation mentions children and modules', async () => {
    const f = mockFetch(204);
    page(() => {}, 1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/child issues become top-level, and no modules are deleted/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/issues/1', expect.objectContaining({ method: 'DELETE' })));
  });

  it('opens the issue page from the list', async () => {
    page();
    await userEvent.click(screen.getByLabelText('Open issue Login'));
    expect(window.location.hash).toBe('#/issues/2');
  });

  describe('issue page', () => {
    const task = mk({ id: 5, type: 'task', title: 'Wire up', ownerId: 1, moduleId: 1 });
    const show = (onChanged = () => {}) => render(<IssuesPage issues={[task]} modules={modules} owners={owners} issueId={5} onChanged={onChanged} />);

    it('edits every field in place and saves them together', async () => {
      const f = mockFetch(200);
      const onChanged = vi.fn();
      show(onChanged);
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
      await userEvent.type(screen.getByLabelText('Title'), '!');
      await userEvent.type(screen.getByLabelText('Description'), 'details');
      await userEvent.selectOptions(screen.getByLabelText('State'), 'code_review');
      await userEvent.click(screen.getByText('Save changes'));
      await waitFor(() => expect(f).toHaveBeenCalledWith('/api/issues/5', expect.objectContaining({ method: 'PUT' })));
      const body = JSON.parse(f.mock.calls[0][1].body);
      expect(body).toMatchObject({ title: 'Wire up!', description: 'details', state: 'code_review', ownerId: 1 });
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('offers Break down on epics, stories and bugs but not tasks', () => {
      for (const type of ['epic', 'story', 'bug'] as const) {
        const { unmount } = render(<IssuesPage issues={[mk({ id: 7, type, title: 'X' })]} modules={modules} owners={owners} issueId={7} onChanged={() => {}} />);
        expect(screen.getByRole('button', { name: 'Break down…' })).toBeInTheDocument();
        unmount();
      }
      show();
      expect(screen.queryByRole('button', { name: 'Break down…' })).toBeNull();
    });

    it('discards the draft', async () => {
      const f = mockFetch(200);
      show();
      await userEvent.type(screen.getByLabelText('Title'), 'x');
      await userEvent.click(screen.getByText('Discard'));
      expect(screen.getByLabelText('Title')).toHaveValue('Wire up');
      expect(f).not.toHaveBeenCalled();
    });

    it('removes the owner with the x, as part of the draft', async () => {
      const f = mockFetch(200);
      show();
      await userEvent.click(screen.getByRole('button', { name: /Remove owner/ }));
      expect(f).not.toHaveBeenCalled();
      await userEvent.click(screen.getByText('Save changes'));
      await waitFor(() => expect(f).toHaveBeenCalled());
      expect(JSON.parse(f.mock.calls[0][1].body).ownerId).toBeNull();
    });

    it('asks before leaving with unsaved edits', async () => {
      show();
      await userEvent.type(screen.getByLabelText('Title'), 'x');
      await userEvent.click(within(screen.getByRole('navigation', { name: 'Issue path' })).getByText('Issues'));
      expect(screen.getByText('Discard changes?')).toBeInTheDocument();
      await userEvent.click(screen.getByText('Keep editing'));
      expect(screen.getByLabelText('Title')).toHaveValue('Wire upx');
      await userEvent.click(within(screen.getByRole('navigation', { name: 'Issue path' })).getByText('Issues'));
      await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
      expect(window.location.hash).toBe('#/issues');
    });
  });
});
