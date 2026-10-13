import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

const mod = (id: number, name: string, over: object = {}) => ({
  id, name, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null, ...over,
});
const base = {
  owners: [], groups: [],
  relations: [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }],
  modules: [mod(1, 'Alpha', { x: 4000, y: 3000 }), mod(2, 'Beta', { x: 5000, y: 3000 })],
};

// Stateful fake backend: position saves persist, GET /graph is served from the same store (like the real server).
function backend() {
  const store = structuredClone(base) as typeof base;
  const f = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const ok = (data: unknown) => ({ status: 200, ok: true, json: async () => data });
    if (url === '/api/modules/positions') {
      const out = body.positions.map((p: { id: number; x: number; y: number }) => Object.assign(store.modules.find((m) => m.id === p.id)!, { x: p.x, y: p.y }));
      return ok(out);
    }
    const pos = /\/api\/modules\/(\d+)\/position/.exec(url);
    if (pos) return ok(Object.assign(store.modules.find((m) => m.id === Number(pos[1]))!, body));
    return ok(structuredClone(store));
  });
  vi.stubGlobal('fetch', f);
  return { store, f };
}

const where = (name: string) => {
  const el = screen.getByText(name).closest('.react-flow__node') as HTMLElement;
  return /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)!.slice(1, 3).map(Number);
};
// d3-drag reads event.view, which jsdom's MouseEvent constructor rejects, so it is attached afterwards.
const mouse = (target: Element | Window, type: string, clientX: number, clientY: number) => {
  const ev = new MouseEvent(type, { bubbles: true, clientX, clientY, button: 0, buttons: 1 });
  Object.defineProperty(ev, 'view', { value: window });
  fireEvent(target, ev);
};
const allPositions = () => ['Alpha', 'Beta'].map(where);

afterEach(() => { vi.unstubAllGlobals(); window.location.hash = ''; });

describe('layout survives leaving and re-entering the diagram', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; constructor() {} });
  });

  const roundTrip = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /Groups/ }));
    await screen.findByText('Add group');
    await user.click(screen.getByRole('button', { name: /Diagram/ }));
    await screen.findByText('Alpha');
  };

  it('after Auto layout, the remounted diagram shows the same positions', async () => {
    const { store } = backend();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Alpha');
    await user.click(screen.getByText('Auto layout'));
    await waitFor(() => expect(store.modules[0].x).not.toBeNull());
    const after = allPositions();
    await roundTrip(user);
    expect(allPositions()).toEqual(after);
    expect(after[0]).toEqual([store.modules[0].x, store.modules[0].y]);
  });

  it('after a single card drag, the remounted diagram shows the dragged position', async () => {
    const { store } = backend();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText('Alpha');
    const node = screen.getByText('Alpha').closest('.react-flow__node') as HTMLElement;
    mouse(node, 'mousedown', 10, 10);
    mouse(window, 'mousemove', 60, 40);
    mouse(window, 'mousemove', 110, 90);
    mouse(window, 'mouseup', 110, 90);
    await waitFor(() => expect(store.modules[0].x).not.toBe(4000));
    const after = allPositions();
    await roundTrip(user);
    expect(allPositions()).toEqual(after);
    expect(after[0]).toEqual([store.modules[0].x, store.modules[0].y]);
  });

  it('snap to grid defaults off and persists in localStorage', async () => {
    backend();
    localStorage.removeItem('pjplanner-snap');
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    const box = await screen.findByRole('button', { name: 'Snap to grid' });
    expect(box).toHaveAttribute('aria-pressed', 'false');
    await user.click(box);
    expect(localStorage.getItem('pjplanner-snap')).toBe('1');
    unmount();
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Snap to grid' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('with snap on, a dragged card is persisted on a multiple of 20', async () => {
    const { store } = backend();
    localStorage.setItem('pjplanner-snap', '1');
    render(<App />);
    await screen.findByText('Alpha');
    const node = screen.getByText('Alpha').closest('.react-flow__node') as HTMLElement;
    mouse(node, 'mousedown', 10, 10);
    mouse(window, 'mousemove', 60, 40);
    mouse(window, 'mousemove', 117, 93);
    mouse(window, 'mouseup', 117, 93);
    await waitFor(() => expect(store.modules[0].x).not.toBe(4000));
    expect(store.modules[0].x! % 20).toBe(0);
    expect(store.modules[0].y! % 20).toBe(0);
    localStorage.removeItem('pjplanner-snap');
  });
});
