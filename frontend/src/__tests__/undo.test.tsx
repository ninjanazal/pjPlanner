import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

vi.mock('../components/GraphView', () => ({
  GraphView: (p: { onMove: (id: number, x: number, y: number) => void }) => <button data-testid="drag" onClick={() => p.onMove(1, 500, 50)}>drag</button>,
}));

const graph = {
  owners: [], groups: [], relations: [],
  modules: [{ id: 1, name: 'Alpha', description: '', ownerIds: [], color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid', x: 400, y: 0, groupId: null }],
};
let puts: { x: number; y: number }[];

beforeEach(() => {
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT' && String(url).endsWith('/modules/1/position')) puts.push(JSON.parse(String(init.body)));
    if (init?.method === 'PUT' && String(url).endsWith('/modules/positions')) puts.push(JSON.parse(String(init.body)).positions[0]);
    const body = init?.method === 'PUT' && String(url).endsWith('/modules/positions') ? [] : graph;
    return { status: 200, ok: true, json: async () => body };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('undo / redo', () => {
  it('Ctrl+Z puts the card back and Ctrl+Y moves it again', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('drag'));
    await waitFor(() => expect(puts).toHaveLength(1));
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]).toMatchObject({ x: 400, y: 0 });
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expect(puts).toHaveLength(3));
    expect(puts[2]).toMatchObject({ x: 500, y: 50 });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
