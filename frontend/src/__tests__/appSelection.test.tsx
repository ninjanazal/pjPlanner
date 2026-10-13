import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

// React Flow needs real layout/pointer APIs, so the diagram is stubbed here.
vi.mock('../components/GraphView', () => ({
  GraphView: (p: { tools?: React.ReactNode; graph: { modules: { id: number; name: string }[] }; onNodeClick: (id: number) => void }) => (
    <div>{p.tools}{p.graph.modules.map((m) => (
      <button key={m.id} data-testid="module-card" onClick={(e) => p.onNodeClick(m.id)}>{m.name}</button>
    ))}</div>
  ),
}));

const mod = (id: number, name: string) => ({
  id, name, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: id * 400, y: 0, groupId: null,
});
const graph = { owners: [], groups: [], relations: [], modules: [mod(1, 'Alpha'), mod(2, 'Beta')] };

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json: async () => graph }))));
afterEach(() => vi.unstubAllGlobals());

describe('app selection', () => {
  it('clicking a card opens its popup, even with shift held, and shows no link-shortcut hint', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard('{Shift>}');
    await user.click((await screen.findAllByTestId('module-card'))[0]);
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
});
