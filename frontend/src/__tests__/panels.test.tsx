import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModuleDialog } from '../components/ModuleDialog';
import { LinkDialog } from '../components/LinkDialog';
import type { Graph, Module } from '../types';

const graph: Graph = {
  owners: [{ id: 1, name: 'Ann', color: '#ff0000', icon: '🧑' }],
  modules: [
    { id: 1, name: 'Auth', description: 'd', ownerIds: [], color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null },
    { id: 2, name: 'Billing', description: '', ownerIds: [1], color: '#112233', icon: '🔐', apiItems: [{ id: 5, kind: 'function', name: 'login', signature: 'login(u)', description: '' }], textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null },
  ],
  relations: [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }],
  groups: [{ id: 7, name: 'Core', color: null, icon: '🧱', parentId: null }],
};

const renderEdit = async (module: Module, onChanged: (id?: number | null) => void = () => {}) => {
  render(<ModuleDialog graph={graph} module={module} onChanged={onChanged} onClose={() => {}} />);
  await userEvent.click(screen.getByText('Edit'));
};

const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('ModuleDialog', () => {
  it('saves edits with PUT including owners', async () => {
    const f = mockFetch(200, { id: 1 });
    const onChanged = vi.fn();
    await renderEdit(graph.modules[0], onChanged);
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Auth2');
    await userEvent.click(screen.getByLabelText(/Ann/));
    expect(screen.getByTestId('owner-swatch')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/modules/1');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'Auth2', ownerIds: [1] });
  });

  it('shows inline API validation error', async () => {
    mockFetch(400, { error: { code: 'validation', message: 'name is required' } });
    const onChanged = vi.fn();
    render(<ModuleDialog graph={graph} module={null} onChanged={onChanged} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Create'));
    expect(await screen.findByRole('alert')).toHaveTextContent('name is required');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('requires confirmation stating cascade before delete', async () => {
    const f = mockFetch(204);
    const onChanged = vi.fn();
    await renderEdit(graph.modules[0], onChanged);
    await userEvent.click(screen.getByText('Delete'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/cascade/);
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Delete'));
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/modules/1', expect.objectContaining({ method: 'DELETE' })));
  });

  it('creates a link with optional label', async () => {
    const f = mockFetch(201, { id: 9 });
    await renderEdit(graph.modules[1]);
    await userEvent.selectOptions(screen.getByLabelText('Link target'), 'Auth');
    await userEvent.type(screen.getByLabelText('Link label'), 'uses');
    fireEvent.change(screen.getByLabelText('Arrow colour'), { target: { value: '#00aa00' } });
    await userEvent.click(screen.getByText('Create link'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ sourceId: 2, targetId: 1, label: 'uses', color: '#00aa00' });
  });
});

describe('ModuleDialog group', () => {
  it('sends groupId from the Group select and null for None', async () => {
    const f = mockFetch(200, { id: 1 });
    await renderEdit(graph.modules[0]);
    await userEvent.selectOptions(screen.getByLabelText('Group'), '🧱 Core');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body).groupId).toBe(7);
    cleanup();
    await renderEdit({ ...graph.modules[0], groupId: 7 });
    await userEvent.selectOptions(screen.getByLabelText('Group'), 'None');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(JSON.parse(f.mock.calls[1][1].body).groupId).toBeNull();
  });

});

describe('ModuleDialog look and API', () => {
  const bodyOf = (f: any) => JSON.parse(f.mock.calls[0][1].body);

  it('colour reset sends null and keeps icon/apiItems', async () => {
    const f = mockFetch(200, { id: 2 });
    await renderEdit(graph.modules[1]);
    await userEvent.click(screen.getByText('Reset colour'));
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(bodyOf(f)).toMatchObject({ color: null, icon: '🔐', apiItems: [{ id: 5, name: 'login' }] });
  });

  it('quick-pick and clear set icon', async () => {
    const f = mockFetch(200, { id: 1 });
    await renderEdit(graph.modules[0]);
    await userEvent.click(screen.getByLabelText('Pick 📦'));
    expect(screen.getByLabelText('Icon')).toHaveValue('📦');
    await userEvent.click(screen.getByText('Clear icon'));
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(bodyOf(f).icon).toBeNull();
  });

  it('adds, edits and removes items (with confirm)', async () => {
    const f = mockFetch(200, { id: 2 });
    await renderEdit(graph.modules[1]);
    await userEvent.click(screen.getByText('Add API item'));
    await userEvent.selectOptions(screen.getByLabelText('Item kind'), 'endpoint');
    await userEvent.type(screen.getByLabelText('Item name'), 'GET /x');
    await userEvent.type(screen.getByLabelText('Item signature'), '() => X');
    await userEvent.click(screen.getByText('Done'));
    await userEvent.click(screen.getByLabelText('Edit login'));
    await userEvent.type(screen.getByLabelText('Item name'), '2');
    await userEvent.click(screen.getByText('Done'));
    await userEvent.click(screen.getByLabelText('Remove GET /x'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/GET \/x/);
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    expect(screen.getAllByText('GET /x').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByLabelText('Remove GET /x'));
    await userEvent.click(screen.getByText('Confirm'));
    expect(screen.queryAllByText('GET /x')).toHaveLength(0);
    await userEvent.click(screen.getByText('Add API item'));
    await userEvent.type(screen.getByLabelText('Item name'), 'Ev');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(bodyOf(f).apiItems).toEqual([
      { id: 5, kind: 'function', name: 'login2', signature: 'login(u)', description: '' },
      { kind: 'function', name: 'Ev', signature: '', description: '' },
    ]);
  });

  it('renders 400 validation error inline', async () => {
    mockFetch(400, { error: { code: 'validation_error', message: 'apiItems[0].name is required' } });
    await renderEdit(graph.modules[0]);
    await userEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('apiItems[0].name is required');
  });
});

describe('ModuleDialog create', () => {
  it('creates a module with API items via POST', async () => {
    const f = mockFetch(201, { id: 9 });
    const onChanged = vi.fn();
    render(<ModuleDialog graph={graph} module={null} onChanged={onChanged} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Search');
    await userEvent.click(screen.getByText('Add API item'));
    await userEvent.type(screen.getByLabelText('Item name'), 'query');
    await userEvent.type(screen.getByLabelText('Item signature'), 'query(q)');
    await userEvent.selectOptions(screen.getByLabelText('Item kind'), 'endpoint');
    await userEvent.click(screen.getByText('Done'));
    await userEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(9));
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/modules');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ name: 'Search', apiItems: [{ kind: 'endpoint', name: 'query', signature: 'query(q)' }] });
    expect(body).not.toHaveProperty('status');
    expect(body.apiItems[0]).not.toHaveProperty('key');
  });
});

describe('ModuleDialog stroke and text fields', () => {
  it('sends textColor, strokeColor and strokeStyle; reset sends null', async () => {
    const f = mockFetch(200, { id: 1 });
    await renderEdit(graph.modules[0]);
    fireEvent.input(screen.getByLabelText('Text colour'), { target: { value: '#ff0000' } });
    fireEvent.input(screen.getByLabelText('Stroke colour'), { target: { value: '#00ff00' } });
    await userEvent.selectOptions(screen.getByLabelText('Stroke type'), 'dashed');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ textColor: '#ff0000', strokeColor: '#00ff00', strokeStyle: 'dashed' });
    f.mockClear();
    cleanup();
    await renderEdit({ ...graph.modules[0], textColor: '#ff0000', strokeColor: '#00ff00', strokeStyle: 'dashed' });
    await userEvent.click(screen.getByText('Reset text colour'));
    await userEvent.click(screen.getByText('Reset stroke colour'));
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ textColor: null, strokeColor: null, strokeStyle: 'dashed' });
  });
});

describe('ModuleDialog API overview', () => {
  it('shows items grouped by kind with counts and coloured badges', () => {
    const m = { ...graph.modules[1], apiItems: [
      { id: 1, kind: 'endpoint' as const, name: 'login', signature: 'POST /login', description: 'Sign in' },
      { id: 2, kind: 'endpoint' as const, name: 'out', signature: 'GET /out', description: '' },
      { id: 3, kind: 'event' as const, name: 'ev', signature: '', description: '' },
    ] };
    render(<ModuleDialog graph={graph} module={m} onChanged={() => {}} onClose={() => {}} />);
    const ov = within(screen.getByLabelText('API overview'));
    expect(ov.getAllByTestId('api-card')).toHaveLength(3);
    expect(ov.getByText('POST')).toHaveClass('method', 'm-POST');
    expect(ov.getByText('endpoint')).toHaveClass('kind', 'k-endpoint');
    expect(ov.getByText('Sign in')).toBeInTheDocument();
  });
  it('shows an empty state with an add button', async () => {
    render(<ModuleDialog graph={graph} module={graph.modules[0]} onChanged={() => {}} onClose={() => {}} />);
    const ov = within(screen.getByLabelText('API overview'));
    expect(ov.getByText('No API documented yet.')).toBeInTheDocument();
    await userEvent.click(ov.getByText('Add API item'));
    expect(screen.getByRole('heading', { name: 'Edit Auth' })).toBeInTheDocument();
    expect(screen.getByLabelText('Item name')).toBeInTheDocument();
  });
});

describe('LinkDialog arrow colour', () => {
  const rel = { id: 1, sourceId: 1, targetId: 2, label: 'uses', color: null };
  it('sends the picked colour, and null after Reset', async () => {
    const f = mockFetch(200, { id: 1 });
    render(<LinkDialog graph={graph} relation={rel} onChanged={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Arrow colour'), { target: { value: '#ff0000' } });
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/relations/1');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ label: 'uses', color: '#ff0000' });
    await userEvent.click(screen.getByText('Reset arrow colour'));
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ label: 'uses', color: null });
  });
});
