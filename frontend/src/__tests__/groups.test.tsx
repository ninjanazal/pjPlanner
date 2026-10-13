import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupsPage } from '../components/GroupsPage';
import { autoLayout, cardHeight, cardWidth } from '../layout';
import { dropGroup, groupBoxes, translateGroup, GROUP_HEADER, GROUP_PAD } from '../groupBoxes';
import type { Graph, Module } from '../types';

const mod = (id: number, name: string, groupId: number | null): Module => ({
  id, name, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId,
});
const graph: Graph = {
  owners: [],
  groups: [{ id: 1, name: 'Billing', color: '#ff8800', icon: '💳', parentId: null }, { id: 2, name: 'Empty', color: null, icon: null, parentId: null }],
  modules: [mod(1, 'Invoices', 1), mod(2, 'Payments', 1), mod(3, 'Auth', null), mod(4, 'Gateway', null)],
  relations: [{ id: 1, sourceId: 3, targetId: 1, label: null, color: null }, { id: 2, sourceId: 1, targetId: 2, label: null, color: null }, { id: 3, sourceId: 2, targetId: 4, label: null, color: null }],
};
const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('GroupsPage', () => {
  it('lists group tiles with counts, shows members read-only, Edit opens the form', async () => {
    const open = vi.fn();
    render(<GroupsPage graph={graph} onChanged={() => {}} onOpenModule={open} />);
    expect(within(screen.getByLabelText('Group Billing')).getByText('2 modules')).toBeInTheDocument();
    expect(screen.getByLabelText('Group Billing')).toHaveTextContent('💳');
    await userEvent.click(screen.getByLabelText('Group Billing'));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByLabelText('Open module Invoices')).toBeInTheDocument();
    expect(screen.queryByLabelText('Open module Auth')).toBeNull();
    await userEvent.click(screen.getByLabelText('Open module Payments'));
    expect(open).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Name')).toHaveValue('Billing');
  });

  it('creates a group and shows 409 inline', async () => {
    const f = mockFetch(201, { id: 9, name: 'New', color: null, icon: null });
    const changed = vi.fn();
    render(<GroupsPage graph={graph} onChanged={changed} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByText('Add group'));
    await userEvent.type(screen.getByLabelText('Name'), 'New');
    await userEvent.click(screen.getByText('Create group'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/groups');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'New', color: null, icon: expect.any(String), parentId: null });
    mockFetch(409, { error: { code: 'conflict', message: 'Group name already exists' } });
    await userEvent.click(screen.getByText('Add group'));
    await userEvent.type(screen.getByLabelText('Name'), 'billing');
    await userEvent.click(screen.getByText('Create group'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Group name already exists');
  });

  it('delete confirmation says modules are kept ungrouped', async () => {
    const f = mockFetch(204);
    render(<GroupsPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Group Billing'));
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.click(screen.getByText('Delete group'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/move up one level.*become ungrouped.*no modules are deleted/);
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/groups/1', expect.objectContaining({ method: 'DELETE' })));
  });
});

describe('group layout and boxes', () => {
  const size = (m: Module) => ({ w: cardWidth(m.name, m.icon), h: cardHeight(0) });
  const rects = (pos: Map<number, { x: number; y: number }>) => new Map(graph.modules.map((m) => [m.id, { ...pos.get(m.id)!, ...size(m) }]));

  it('keeps group members together and ungrouped cards outside the container', () => {
    const pos = autoLayout(graph);
    const r = rects(pos);
    const boxes = groupBoxes(graph.modules, graph.groups, r);
    const box = boxes.get(1)!;
    [1, 2].forEach((id) => {
      const c = r.get(id)!;
      expect(c.x).toBeGreaterThanOrEqual(box.x + GROUP_PAD - 1);
      expect(c.y).toBeGreaterThanOrEqual(box.y + GROUP_PAD + GROUP_HEADER - 1);
    });
    [3, 4].forEach((id) => {
      const c = r.get(id)!;
      const overlap = c.x < box.x + box.w && c.x + c.w > box.x && c.y < box.y + box.h && c.y + c.h > box.y;
      expect(overlap).toBe(false);
    });
    expect(boxes.has(2)).toBe(false);
  });

  it('dropGroup joins a box on drop inside, and leaves the group unchanged when over no box (incl. sole member)', () => {
    const cards = new Map([
      [1, { x: 0, y: 0, w: 200, h: 80 }], [2, { x: 300, y: 0, w: 200, h: 80 }],
      [3, { x: 1000, y: 0, w: 200, h: 80 }], [4, { x: 1000, y: 500, w: 200, h: 80 }],
    ]);
    const g = graph.groups;
    expect(dropGroup(graph.modules, g, new Map(cards).set(3, { x: 100, y: 10, w: 200, h: 80 }), 3)).toBe(1);
    expect(dropGroup(graph.modules, g, new Map(cards).set(2, { x: 2000, y: 2000, w: 200, h: 80 }), 2)).toBe(1);
    expect(dropGroup(graph.modules, g, new Map(cards).set(3, { x: 2000, y: 2000, w: 200, h: 80 }), 3)).toBeNull();
    expect(dropGroup(graph.modules, g, new Map(cards).set(1, { x: 260, y: 20, w: 200, h: 80 }), 1)).toBe(1);
    const solo = [mod(1, 'A', 1)];
    expect(dropGroup(solo, g, new Map([[1, { x: 0, y: 0, w: 10, h: 10 }]]), 1)).toBe(1);
    // dropping on another group's box moves the card there
    const two = [mod(1, 'A', 1), mod(2, 'B', 2)];
    const at = new Map([[1, { x: 0, y: 0, w: 100, h: 50 }], [2, { x: 1000, y: 0, w: 100, h: 50 }]]);
    expect(dropGroup(two, g, new Map(at).set(1, { x: 1010, y: 10, w: 100, h: 50 }), 1)).toBe(2);
  });
});

describe('nested groups', () => {
  const groups = [
    { id: 1, name: 'Outer', color: null, icon: null, parentId: null },
    { id: 2, name: 'Inner', color: null, icon: null, parentId: 1 },
    { id: 3, name: 'Hollow', color: null, icon: null, parentId: 1 },
  ];
  const mods = [mod(1, 'A', 1), mod(2, 'B', 2), mod(3, 'C', 2), mod(4, 'D', null)];
  const cards = new Map([
    [1, { x: 0, y: 0, w: 100, h: 50 }], [2, { x: 400, y: 0, w: 100, h: 50 }],
    [3, { x: 400, y: 200, w: 100, h: 50 }], [4, { x: 2000, y: 0, w: 100, h: 50 }],
  ]);

  it('boxes nest with a padding step; groups without modules in their subtree are not drawn', () => {
    const b = groupBoxes(mods, groups, cards);
    const o = b.get(1)!; const i = b.get(2)!;
    expect(b.has(3)).toBe(false);
    expect(i.x).toBe(400 - GROUP_PAD);
    expect(o.x).toBe(0 - GROUP_PAD);
    expect(o.x + o.w).toBeGreaterThanOrEqual(i.x + i.w + GROUP_PAD);
    expect(o.y + o.h).toBeGreaterThanOrEqual(i.y + i.h + GROUP_PAD);
    expect(o.y).toBeLessThanOrEqual(0 - GROUP_PAD - GROUP_HEADER);
  });

  it('dropGroup picks the innermost box (computed without the dragged card)', () => {
    const at = (id: number, x: number, y: number) => new Map(cards).set(id, { x, y, w: 100, h: 50 });
    expect(dropGroup(mods, groups, at(4, 400, 100), 4)).toBe(2);
    expect(dropGroup(mods, groups, at(4, 40, 20), 4)).toBe(1);
    expect(dropGroup(mods, groups, at(4, 5000, 5000), 4)).toBeNull();
    expect(dropGroup(mods, groups, at(2, 5000, 5000), 2)).toBe(2);
  });

  it('translateGroup moves every card in the subtree and nothing else', () => {
    const pos = new Map([...cards].map(([id, r]) => [id, { x: r.x, y: r.y }]));
    const moved = translateGroup(mods, groups, pos, 1, 10, -5);
    expect([...moved.keys()].sort()).toEqual([1, 2, 3]);
    expect(moved.get(2)).toEqual({ x: 410, y: -5 });
    expect([...translateGroup(mods, groups, pos, 2, 1, 1).keys()].sort()).toEqual([2, 3]);
  });

  it('auto layout keeps sibling boxes from overlapping and nests children inside parents', () => {
    const g: Graph = {
      owners: [], groups: [...groups, { id: 4, name: 'Side', color: null, icon: null, parentId: null }],
      modules: [...mods, mod(5, 'E', 4)],
      relations: [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }, { id: 2, sourceId: 3, targetId: 5, label: null, color: null }],
    };
    const pos = autoLayout(g);
    const r = new Map(g.modules.map((m) => [m.id, { ...pos.get(m.id)!, w: cardWidth(m.name, m.icon), h: cardHeight(0) }]));
    const b = groupBoxes(g.modules, g.groups, r);
    const o = b.get(1)!; const i = b.get(2)!; const s = b.get(4)!;
    expect(i.x).toBeGreaterThanOrEqual(o.x); expect(i.x + i.w).toBeLessThanOrEqual(o.x + o.w);
    expect(i.y).toBeGreaterThanOrEqual(o.y); expect(i.y + i.h).toBeLessThanOrEqual(o.y + o.h);
    expect(o.x < s.x + s.w && o.x + o.w > s.x && o.y < s.y + s.h && o.y + o.h > s.y).toBe(false);
  });
});

describe('parent group select', () => {
  const groups = [
    { id: 1, name: 'A', color: null, icon: null, parentId: null },
    { id: 2, name: 'B', color: null, icon: null, parentId: 1 },
    { id: 3, name: 'C', color: null, icon: null, parentId: 2 },
    { id: 4, name: 'D', color: null, icon: null, parentId: null },
  ];
  const g: Graph = { owners: [], groups, modules: [mod(1, 'M', 3)], relations: [] };

  it('excludes self and descendants, shows path labels, and sends parentId', async () => {
    const f = mockFetch(200, { id: 2, name: 'B', color: null, icon: null, parentId: 4 });
    render(<GroupsPage graph={g} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Group B'));
    expect(screen.getByLabelText('Group B')).toHaveTextContent('A / B');
    expect(screen.getByText('Parent group: A')).toBeInTheDocument();
    expect(screen.getByLabelText('Open group C')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Edit'));
    const sel = screen.getByLabelText('Parent group');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['None (top level)', 'A', 'D']);
    await userEvent.selectOptions(sel, 'D');
    await userEvent.click(screen.getByText('Save group'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ name: 'B', parentId: 4 });
  });

  it('shows a server validation error inline', async () => {
    mockFetch(400, { error: { code: 'validation_error', message: 'Group depth exceeds 4' } });
    render(<GroupsPage graph={g} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Group D'));
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.click(screen.getByText('Save group'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Group depth exceeds 4');
  });
});
