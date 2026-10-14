import { render, screen, within } from '@testing-library/react';
import { ProjectOverview } from '../components/ProjectOverview';
import { OwnersPage } from '../components/OwnersPage';
import { parseHash } from '../route';
import type { Graph, Issue, Module, Project, Sprint } from '../types';

const mod = (id: number, ownerIds: number[]): Module => ({
  id, name: `Mod${id}`, description: '', ownerIds, color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const iss = (id: number, p: Partial<Issue> = {}): Issue => ({
  id, type: 'task', title: `T${id}`, description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});
const graph: Graph = {
  owners: [{ id: 1, name: 'Ann', color: null, icon: null }, { id: 2, name: 'Bob', color: null, icon: null }],
  modules: [mod(1, [1]), mod(2, [])], relations: [{ id: 1, sourceId: 2, targetId: 1, label: null, color: null }], groups: [],
};
const sprints = [{ id: 1, name: 'Sprint A', goal: '', state: 'active', issueIds: [], openCount: 0, closedCount: 0 }] as Sprint[];
const issues = [
  iss(1, { type: 'epic', title: 'Launch' }),
  iss(2, { parentId: 1, moduleId: 1, ownerId: 1, sprintId: 1, estimate: 3, state: 'closed' }),
  iss(3, { parentId: 1, moduleId: 1, ownerId: 1, sprintId: 1, estimate: 9 }),
  iss(4, { parentId: 1, moduleId: 2 }),
  iss(5, { type: 'bug', title: 'Crash' }),
];
const project = { id: 1, name: 'Catrina', description: 'Slot cabinet' } as Project;

describe('ProjectOverview', () => {
  const show = () => render(<ProjectOverview project={project} graph={graph} issues={issues} sprints={sprints} />);
  it('shows the project, completion and key numbers', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Catrina' })).toBeInTheDocument();
    expect(screen.getByText('Slot cabinet')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Project summary')).getByText('23%')).toBeInTheDocument(); // 3 of 3+9+1 steps
    expect(screen.getByText('3 of 13 steps done')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Project completion' })).toHaveAttribute('aria-valuenow', '23');
  });
  it('shows coverage numbers instead of a to-do list', () => {
    show();
    const box = within(screen.getByLabelText('Coverage'));
    const val = (label: string) => box.getByText(label).parentElement!.querySelector('b')!.textContent;
    expect(val('Open tasks without owner')).toBe('1');
    expect(val('Open tasks not in a sprint')).toBe('1');
    expect(val('Modules without owner')).toBe('1');
    expect(val('Overloaded owners')).toBe('1');
    expect(screen.queryByText(/side quest/i)).toBeNull();
  });
  it('draws the task board and sprint progress', () => {
    show();
    expect(screen.getByRole('img', { name: /Tasks by state: 2 Open, 0 Code review, 0 Test validation, 1 Closed/ })).toBeInTheDocument();
    const sprintsBox = within(screen.getByLabelText('Sprints'));
    expect(sprintsBox.getByText('Sprint A (active)')).toBeInTheDocument();
    expect(sprintsBox.getByText(/1\/2 tasks · 3\/12 steps · 25%/)).toBeInTheDocument();
  });
  it('shows tasks and steps done per owner, without ranking them', () => {
    show();
    expect(screen.queryByText(/leaderboard/i)).toBeNull();
    const ann = within(screen.getByLabelText('Work by owner')).getByRole('link', { name: 'Ann' }).closest('.rank-row') as HTMLElement;
    expect(within(ann).getByText('1 of 2 tasks done')).toBeInTheDocument();
    expect(within(ann).getByText('3 of 12 steps done')).toBeInTheDocument();
    expect(within(ann).getByText('9 steps left')).toBeInTheDocument();
    expect(screen.queryByText('MVP')).toBeNull();
  });
  it('maps modules and epics', () => {
    show();
    expect(within(screen.getByLabelText('Module map')).getByText(/1 depends on it/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Module map')).getByText(/no owner/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Epics')).getByRole('link', { name: '#1 Launch' })).toHaveAttribute('href', '#/issues/1');
  });
  it('celebrates when everything is done', () => {
    render(<ProjectOverview project={project} graph={graph} issues={[iss(2, { state: 'closed' })]} sprints={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/Every task is done/);
  });
  it('has a route', () => expect(parseHash('#/overview')).toBe('overview'));
});

describe('owner metrics', () => {
  it('shows completion, share of team load and the per-module split on the owner page', () => {
    render(<OwnersPage graph={graph} issues={issues} sprints={sprints} ownerRef={1} onChanged={() => {}} onOpenModule={() => {}} />);
    const box = within(screen.getByLabelText('Owner metrics'));
    expect(box.getByRole('progressbar', { name: 'Owner completion' })).toHaveAttribute('aria-valuenow', '25'); // 3 of 12 steps
    expect(box.getByText('Share of team load').parentElement!.querySelector('b')!.textContent).toBe('100%'); // Ann carries all remaining owned work
    expect(box.getByText('Load rank').parentElement!.querySelector('b')!.textContent).toBe('#1');
    expect(box.getByText('1/2 tasks · 9 steps left')).toBeInTheDocument();
  });
});

describe('speed metrics', () => {
  const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const timed = (id: number, owner: number, module: number, created: number, closed: number): Issue =>
    iss(id, { ownerId: owner, moduleId: module, state: 'closed', createdAt: ago(created), closedAt: ago(closed), closedOwnerId: owner, updatedAt: ago(closed) });
  const data = [timed(1, 1, 1, 30, 28), timed(2, 1, 1, 29, 26), timed(3, 2, 2, 12, 2), timed(4, 2, 2, 11, 1),
    iss(5, { moduleId: 2, createdAt: ago(40), updatedAt: ago(40) }), iss(6, { moduleId: 1, createdAt: ago(50), updatedAt: ago(50) })];
  const g: Graph = { ...graph, modules: [mod(1, [1]), mod(2, [2])], relations: [] };

  it('asks for the first closed task when there is no timing yet', () => {
    render(<ProjectOverview project={project} graph={graph} issues={issues} sprints={sprints} />);
    expect(within(screen.getByLabelText('Speed')).getByText(/Timing starts with the first task closed/)).toBeInTheDocument();
  });
  it('shows lead time, throughput and who is faster', () => {
    render(<ProjectOverview project={project} graph={g} issues={data} sprints={[]} />);
    const speed = within(screen.getByLabelText('Speed'));
    expect(speed.getByText('Avg lead time').parentElement!.querySelector('b')!.textContent).toBe('6.3 d'); // (2+3+10+10)/4 = 6.25 days
    expect(speed.getByRole('img', { name: /Tasks per week/ })).toBeInTheDocument();
    const owners = within(screen.getByLabelText('Owner speed'));
    expect(owners.getByText('Fastest')).toBeInTheDocument(); // Ann: 5 days over 2 steps beats Bob: 20 over 2
  });
  it('names the hottest and coldest module', () => {
    render(<ProjectOverview project={project} graph={g} issues={data} sprints={[]} />);
    const hl = within(screen.getByLabelText('Highlights'));
    expect(hl.getByText('Hottest module').parentElement).toHaveTextContent('Mod2'); // closed work in the last 14 days
    expect(hl.getByText('Coldest module').parentElement).toHaveTextContent(/Mod1.*untouched for 26 days/); // open work, last activity was a task closed 26 days ago
  });
});

describe('sprints card with many sprints', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Sprint ${i + 1}`, goal: '', state: 'planned', issueIds: [], openCount: 0, closedCount: 0 })) as Sprint[];
  it('folds sprints without tasks into one line and puts the active one first', () => {
    const list = [...many.slice(0, 6), { ...many[6], state: 'active' } as Sprint];
    render(<ProjectOverview project={project} graph={graph} issues={[]} sprints={list} />);
    const box = within(screen.getByLabelText('Sprints'));
    expect(box.getAllByText(/tasks ·/)).toHaveLength(1);
    expect(box.getByText('Sprint 7 (active)')).toBeInTheDocument();
    expect(box.getByText('6 more sprints have no tasks yet')).toBeInTheDocument();
    expect(box.getByText('1 active · 6 planned')).toBeInTheDocument();
  });
});
