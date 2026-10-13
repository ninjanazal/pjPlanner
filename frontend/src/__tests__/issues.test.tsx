import { render, screen, waitFor, within } from '@testing-library/react';
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
const page = (onChanged = () => {}) => render(<IssuesPage issues={issues} modules={modules} owners={owners} onChanged={onChanged} />);

describe('IssuesPage', () => {
  it('shows tree with badges, chips and hides closed by default', async () => {
    page();
    const items = screen.getAllByRole('treeitem');
    expect(items[0]).toHaveTextContent('#1');
    expect(items[0]).toHaveTextContent('Ana');
    expect(within(items[0]).getAllByTestId('module-chip')[0]).toHaveTextContent('Auth');
    expect(screen.getByLabelText('Edit issue Login')).toBeInTheDocument();
    expect(within(screen.getByRole('tree')).queryByLabelText('Edit issue Finished')).toBeNull();
    expect(screen.getByText('Closed (1)')).toBeInTheDocument(); // closed work is kept, just tucked away
    await userEvent.click(screen.getByLabelText('Hide closed'));
    expect(within(screen.getByRole('tree')).getByLabelText('Edit issue Finished')).toBeInTheDocument();
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
    await userEvent.selectOptions(screen.getByLabelText('Module'), '2');
    await userEvent.click(screen.getByText('Create issue'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/issues');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'task', title: 'Sub', parentId: 2, moduleId: 2, ownerId: null, state: 'open' });
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
    await userEvent.click(screen.getByText('Create issue'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad parent');
  });

  it('delete confirmation mentions children and modules', async () => {
    const f = mockFetch(204);
    page();
    await userEvent.click(screen.getByLabelText('Edit issue Launch'));
    await userEvent.click(screen.getByText('Delete issue'));
    expect(screen.getByText(/child issues become top-level, and no modules are deleted/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/issues/1', expect.objectContaining({ method: 'DELETE' })));
  });
});
