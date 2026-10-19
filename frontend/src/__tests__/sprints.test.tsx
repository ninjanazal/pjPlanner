import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SprintsPage } from '../components/SprintsPage';
import { groupIssues } from '../sprintGroups';
import type { Issue, Module, Owner, Sprint } from '../types';

const owner = (id: number, name: string): Owner => ({ id, name, color: null, icon: null });
const mod = (id: number, name: string) => ({ id, name, color: null, icon: null } as Module);
const issue = (id: number, o: Partial<Issue> = {}): Issue => ({
  id, type: 'task', title: `T${id}`, description: '', parentId: null, ownerId: null, state: 'open', moduleId: null,
  sprintId: null, childIds: [], rollupModuleIds: [], ...o,
});
const sprint = (id: number, state: Sprint['state'], o: Partial<Sprint> = {}): Sprint =>
  ({ id, name: `S${id}`, goal: '', state, issueIds: [], openCount: 0, closedCount: 0, ...o });

describe('groupIssues', () => {
  const modules = [mod(1, 'Auth'), mod(2, 'Billing')];
  const owners = [owner(1, 'Ana')];
  const issues = [issue(1, { moduleId: 2, ownerId: 1 }), issue(2, { moduleId: 1 }), issue(3)];
  it('groups by module with a trailing bucket for issues without one', () => {
    const g = groupIssues(issues, 'module', modules, owners);
    expect(g.map((x) => [x.label, x.issues.map((i) => i.id)])).toEqual([['Auth', [2]], ['Billing', [1]], ['No module', [3]]]);
  });
  it('groups by owner', () => {
    const g = groupIssues(issues, 'owner', modules, owners);
    expect(g.map((x) => [x.label, x.issues.map((i) => i.id)])).toEqual([['Ana', [1]], ['Unassigned', [2, 3]]]);
  });
  it('groups by epic (children only), with the rest under No epic', () => {
    const epic = issue(10, { type: 'epic', title: 'Big' });
    const kids = [issue(11, { parentId: 10 }), issue(12)];
    const g = groupIssues(kids, 'epic', modules, owners, [epic, ...kids]);
    expect(g.map((x) => [x.label, x.issues.map((i) => i.id)])).toEqual([['⚡ Big', [11]], ['No epic', [12]]]);
  });
  it('does not group when asked', () => {
    expect(groupIssues(issues, 'none', modules, owners)).toHaveLength(1);
  });
});

describe('SprintsPage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  const fetchOk = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

  it('shows the active sprint grouped by module and the backlog separately', () => {
    render(<SprintsPage sprints={[sprint(1, 'active', { openCount: 1 })]} modules={[mod(1, 'Auth')]} owners={[]} onChanged={() => {}}
      issues={[issue(1, { sprintId: 1, moduleId: 1 }), issue(2)]} />);
    expect(within(screen.getByRole('region', { name: 'Auth' })).getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('T2')).toBeInTheDocument(); // backlog
    expect(screen.getByRole('button', { name: 'Close sprint' })).toBeInTheDocument();
  });

  it('asks before closing a sprint', () => {
    const f = fetchOk();
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SprintsPage sprints={[sprint(1, 'active')]} modules={[]} owners={[]} onChanged={() => {}} issues={[issue(1, { sprintId: 1 })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close sprint' }));
    expect(conf).toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('never lists an epic as sprint work or backlog; shows it as a chip on its children', () => {
    render(<SprintsPage sprints={[sprint(1, 'active')]} modules={[]} owners={[]} onChanged={() => {}}
      issues={[issue(1, { type: 'epic', title: 'Big goal' }), issue(2, { parentId: 1, title: 'Child' })]} />);
    expect(screen.getByText('Child')).toBeInTheDocument();
    expect(screen.getAllByText(/Big goal/, { selector: 'span[title="Epic"]' })).toHaveLength(1); // only the chip on the child
  });

  it('adds a backlog issue to a sprint with a full issue update', async () => {
    const f = fetchOk(); const changed = vi.fn();
    render(<SprintsPage sprints={[sprint(1, 'active')]} modules={[]} owners={[]} onChanged={changed} issues={[issue(2)]} />);
    await userEvent.selectOptions(screen.getByLabelText('Add issue T2 to sprint'), '1');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/issues/2');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'T2', sprintId: 1 });
    expect(changed).toHaveBeenCalled();
  });

  it('disables Start while another sprint is active', () => {
    render(<SprintsPage sprints={[sprint(1, 'active'), sprint(2, 'planned')]} modules={[]} owners={[]} onChanged={() => {}} issues={[]} />);
    expect(screen.getByRole('button', { name: 'Start sprint' })).toBeDisabled();
  });

  it('offers Auto on an unassigned task and for the whole sprint', async () => {
    const f = fetchOk();
    const m = { ...mod(1, 'Auth'), ownerIds: [1] };
    render(<SprintsPage sprints={[sprint(1, 'active', { openCount: 1 })]} modules={[m]} owners={[owner(1, 'Ana')]} onChanged={() => {}}
      issues={[issue(1, { sprintId: 1, moduleId: 1 })]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Auto-assign T1' }));
    expect((f.mock.calls[0] as [string])[0]).toBe('/api/issues/1/assign');
    await userEvent.click(screen.getByRole('button', { name: /Auto-assign 1$/ }));
    expect((f.mock.calls[1] as [string])[0]).toBe('/api/sprints/1/assign');
  });
});
