// @ts-expect-error node types are not installed; vitest runs in node
import { readFileSync } from 'node:fs';
import mainSrc from '../main.tsx?raw';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnersPage } from '../components/OwnersPage';
import { parseHash, parseOwnerRef } from '../route';
import type { Graph, Issue, Module, Sprint } from '../types';

const mkIssue = (p: Partial<Issue> & Pick<Issue, 'id' | 'title'>): Issue => ({
  type: 'task', description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});

const mod = (id: number, name: string, ownerIds: number[], extra: Partial<Module> = {}): Module => ({
  id, name, description: '', ownerIds, color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null, ...extra,
});
const graph: Graph = {
  owners: [{ id: 1, name: 'Ann', color: '#ff0000', icon: '🧑' }, { id: 2, name: 'Bob', color: null, icon: null }],
  modules: [mod(1, 'Auth', [1], { icon: '🔐', color: '#112233' }), mod(2, 'Billing', [1, 2]), mod(3, 'Orphan', [])],
  relations: [], groups: [],
};
const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

const page = (ownerRef: number | 'new' | null, extra: Partial<React.ComponentProps<typeof OwnersPage>> = {}) =>
  render(<OwnersPage graph={graph} ownerRef={ownerRef} onChanged={() => {}} onOpenModule={() => {}} {...extra} />);

describe('owners list', () => {
  it('lists owners with module counts, links to their pages and the unassigned hint', () => {
    page(null);
    expect(within(screen.getByLabelText('Owner Ann')).getByText('2 modules')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Owner Bob')).getByText('1 module')).toBeInTheDocument();
    expect(screen.getByLabelText('Owner Ann')).toHaveAttribute('href', '#/owners/1');
    expect(screen.getByText(/no owner: Orphan/)).toBeInTheDocument();
  });
  it('tiles render icon and colour accent', () => {
    page(null);
    expect(screen.getByLabelText('Owner Ann')).toHaveTextContent('🧑');
    expect(screen.getByLabelText('Owner Ann').style.borderLeft).toContain('rgb(255, 0, 0)');
    expect(screen.getByLabelText('Owner Bob')).not.toHaveTextContent('🧑');
  });
  it('Add owner goes to the new-owner page', async () => {
    page(null);
    await userEvent.click(screen.getByText('Add owner'));
    expect(window.location.hash).toBe('#/owners/new');
  });
});

describe('owner page', () => {
  it('shows the owner, their modules and edits in place', async () => {
    const open = vi.fn();
    page(1, { onOpenModule: open });
    expect(screen.getByTestId('entity-head')).toHaveTextContent('🧑');
    expect(screen.getByLabelText('Name')).toHaveValue('Ann');
    expect(screen.queryByText('Save changes')).toBeNull(); // nothing to save yet
    expect(screen.getByLabelText('Open module Auth')).toHaveTextContent('🔐');
    expect(screen.getByLabelText('Open module Billing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Open module Orphan')).toBeNull();
    await userEvent.click(screen.getByLabelText('Open module Auth'));
    expect(open).toHaveBeenCalledWith(1);
  });
  it('says so for an owner that does not exist', () => {
    page(99);
    expect(screen.getByText(/does not exist/)).toBeInTheDocument();
  });
  it('creates an owner with colour and icon, no email, and shows 409 inline', async () => {
    const f = mockFetch(201, { id: 9, name: 'Cy', color: '#00ff00', icon: '🔐' });
    const changed = vi.fn();
    page('new', { onChanged: changed });
    expect(screen.queryByLabelText('Email')).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Cy');
    fireEvent.input(screen.getByLabelText('Colour'), { target: { value: '#00ff00' } });
    await userEvent.click(screen.getByLabelText('Pick 🔐'));
    expect(screen.getByTestId('entity-head')).toHaveTextContent('🔐');
    await userEvent.click(screen.getByText('Create owner'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Cy', color: '#00ff00', icon: '🔐' });
    expect(window.location.hash).toBe('#/owners/9');
  });
  it('shows a 409 from the server inline', async () => {
    mockFetch(409, { error: { code: 'conflict', message: 'Owner name already exists' } });
    page('new');
    await userEvent.type(screen.getByLabelText('Name'), 'ann');
    await userEvent.click(screen.getByText('Create owner'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Owner name already exists');
  });
  it('edit sends null when colour and icon are reset', async () => {
    const f = mockFetch(200, { id: 1, name: 'Ann', color: null, icon: null });
    page(1);
    expect(screen.getByLabelText('Icon')).toHaveValue('🧑');
    await userEvent.click(screen.getByText('Reset colour'));
    await userEvent.click(screen.getByText('Clear icon'));
    await userEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners/1');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Ann', color: null, icon: null });
  });
  it('discard drops the draft', async () => {
    const f = mockFetch(200, {});
    page(1);
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(screen.getByText('Discard'));
    expect(screen.getByLabelText('Name')).toHaveValue('Ann');
    expect(f).not.toHaveBeenCalled();
  });
  it('asks before leaving with unsaved edits', async () => {
    page(1);
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Owner path' })).getByText('Owners'));
    expect(screen.getByText('Discard changes?')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Keep editing'));
    expect(screen.getByLabelText('Name')).toHaveValue('Annx');
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Owner path' })).getByText('Owners'));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Discard'));
    expect(window.location.hash).toBe('#/owners');
  });
  it('delete needs confirmation mentioning unassignment', async () => {
    const f = mockFetch(204);
    const changed = vi.fn();
    page(1, { onChanged: changed });
    await userEvent.click(screen.getByText('Delete owner'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/unassigned from 2 module/);
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Delete owner'));
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners/1');
    expect(f.mock.calls[0][1].method).toBe('DELETE');
  });
  it('shows an empty state for an owner without modules', () => {
    page(2, { graph: { ...graph, modules: [] } });
    expect(screen.getByText(/No modules assigned/)).toBeInTheDocument();
  });
});

describe('owner list search and sort', () => {
  const issues = [
    mkIssue({ id: 1, title: 'A', ownerId: 1, moduleId: 1 }), mkIssue({ id: 2, title: 'B', ownerId: 1, moduleId: 1, state: 'closed' }),
    mkIssue({ id: 3, title: 'C', ownerId: 2, moduleId: 2 }), mkIssue({ id: 4, title: 'D', ownerId: 2, moduleId: 2 }),
  ];
  it('searches fuzzily and sorts by open tasks', async () => {
    page(null, { issues });
    expect(within(screen.getByLabelText('Owner Bob')).getByText('2 open tasks')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Owner Ann')).getByText('1 open task')).toBeInTheDocument();
    const order = () => screen.getAllByLabelText(/^Owner /).map((e) => e.getAttribute('aria-label'));
    expect(order()).toEqual(['Owner Ann', 'Owner Bob']);
    await userEvent.selectOptions(screen.getByLabelText('Sort owners'), 'open');
    expect(order()).toEqual(['Owner Bob', 'Owner Ann']);
    await userEvent.type(screen.getByLabelText('Search owners'), 'an');
    expect(order()).toEqual(['Owner Ann']);
    await userEvent.clear(screen.getByLabelText('Search owners'));
    await userEvent.type(screen.getByLabelText('Search owners'), 'zzz');
    expect(screen.getByText(/No owner matches/)).toBeInTheDocument();
  });
});

describe('owner statistics and modules', () => {
  const sprints = [{ id: 1, name: 'S1', goal: '', state: 'active', issueIds: [], openCount: 0, closedCount: 0 }] as Sprint[];
  const day = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  const issues = [
    mkIssue({ id: 1, title: 'Login', ownerId: 1, moduleId: 1, sprintId: 1, estimate: 3 }),
    mkIssue({ id: 2, title: 'Backlog thing', ownerId: 1, moduleId: 2, state: 'code_review' }),
    mkIssue({ id: 3, title: 'Done thing', ownerId: 1, moduleId: 1, state: 'closed', createdAt: ago(10), closedAt: ago(8), closedOwnerId: 1 }),
  ];
  it('shows completion, counts, speed and the tasks grouped by sprint, closed on demand', async () => {
    page(1, { issues, sprints });
    const box = within(screen.getByLabelText('Owner metrics'));
    expect(box.getByRole('progressbar', { name: 'Owner completion' })).toHaveAttribute('aria-valuenow', '20'); // 1 of 5 steps
    expect(box.getByRole('img', { name: /Tasks by state: 1 open, 1 code review, 0 test validation, 1 closed/ })).toBeInTheDocument();
    expect(box.getByText('Avg lead time').parentElement!.querySelector('b')!.textContent).toBe('2.0 d');
    expect(box.getByText('Steps left').parentElement!.querySelector('b')!.textContent).toBe('4');
    expect(box.getByRole('img', { name: /Closed per week/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'S1 (active)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backlog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Login' })).toHaveAttribute('href', '#/issues/1');
    expect(screen.queryByText('Done thing')).toBeNull();
    await userEvent.click(screen.getByLabelText('Show closed tasks'));
    expect(screen.getByText('Done thing')).toBeInTheDocument();
  });
  it('assigns a module found by fuzzy search, keeping the module description', async () => {
    const f = mockFetch(200, { id: 1, name: 'Ann', color: null, icon: null });
    const changed = vi.fn();
    page(2, { onChanged: changed });
    await userEvent.type(screen.getByLabelText('Add module'), 'orp');
    await userEvent.click(screen.getByRole('option', { name: /Orphan/ }));
    expect(screen.getByLabelText('Open module Orphan')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/modules/3');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Orphan', description: '', ownerIds: [2] });
  });
  it('unassigning a module asks first when it holds their unfinished tasks, then unassigns them', async () => {
    const f = mockFetch(200, {});
    page(1, { issues, sprints });
    await userEvent.click(screen.getByLabelText('Unassign module Billing'));
    await userEvent.click(screen.getByText('Save changes'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/1 unfinished task/);
    await userEvent.click(screen.getByText('Save and unassign'));
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
    expect(f.mock.calls[0][0]).toBe('/api/modules/2');
    expect(JSON.parse(f.mock.calls[0][1].body).ownerIds).toEqual([2]);
    expect(f.mock.calls[1][0]).toBe('/api/issues/2');
    expect(JSON.parse(f.mock.calls[1][1].body).ownerId).toBeNull();
  });
});

describe('hash routing', () => {
  it('parses hashes', () => {
    expect(parseHash('#/owners')).toBe('owners');
    expect(parseHash('#/groups')).toBe('groups');
    expect(parseHash('#/')).toBe('diagram');
    expect(parseHash('')).toBe('diagram');
    expect(parseHash('#/owners/3')).toBe('owners');
    expect(parseOwnerRef('#/owners/3')).toBe(3);
    expect(parseOwnerRef('#/owners/new')).toBe('new');
    expect(parseOwnerRef('#/owners')).toBeNull();
  });
});

describe('fonts', () => {
  it('uses a monospace stack and no Caveat', () => {
    const css: string = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/--mono: 'JetBrains Mono'.*monospace/);
    expect(css).not.toMatch(/Caveat/i);
    expect(mainSrc).toContain('@fontsource/jetbrains-mono');
  });
});
