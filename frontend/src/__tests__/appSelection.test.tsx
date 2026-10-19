import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

// React Flow needs real layout/pointer APIs, so the diagram is stubbed here.
vi.mock('../components/GraphView', () => ({
  GraphView: (p: { tools?: React.ReactNode; onAdd: () => void; graph: { modules: { id: number; name: string }[] }; onNodeClick: (id: number) => void; onNodeOpen: (id: number) => void; onLinkClick: (id: number) => void; onLinkOpen: (id: number) => void; onMove: (id: number, x: number, y: number) => void }) => (
    <div><button onClick={p.onAdd}>Add module</button>{p.tools}<button data-testid="link" onClick={() => p.onLinkClick(1)} onDoubleClick={() => p.onLinkOpen(1)}>link</button><button data-testid="drag" onClick={() => p.onMove(1, 500, 50)}>drag</button>{p.graph.modules.map((m) => (
      <button key={m.id} data-testid="module-card" onClick={() => p.onNodeClick(m.id)} onDoubleClick={() => p.onNodeOpen(m.id)}>{m.name}</button>
    ))}</div>
  ),
}));

const mod = (id: number, name: string) => ({
  id, name, description: '', color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: id * 400, y: 0, groupId: null,
});
const graph = { owners: [], groups: [], relations: [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }], modules: [mod(1, 'Alpha'), mod(2, 'Beta')] };

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => graph }))));
afterEach(() => vi.unstubAllGlobals());

describe('app selection', () => {
  it('one click only selects; double click opens the popup, even with shift held, and shows no link-shortcut hint', async () => {
    const user = userEvent.setup();
    render(<App />);
    const card = (await screen.findAllByTestId('module-card'))[0];
    await user.click(card);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Shift>}');
    await user.dblClick(card);
    await user.keyboard('{/Shift}');
    expect(screen.getByRole('dialog', { name: /Alpha/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Shift-click/)).toBeNull();
  });
  it('Add module opens the popup in create mode', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByText(/Add module/));
    expect(screen.getByRole('dialog', { name: 'New module' })).toBeInTheDocument();
    expect(screen.getByText('Create')).toBeInTheDocument();
  });
  it('one click on a link only selects it; double click opens its details', async () => {
    const user = userEvent.setup();
    render(<App />);
    const link = await screen.findByTestId('link');
    await user.click(link);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.dblClick(link);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
