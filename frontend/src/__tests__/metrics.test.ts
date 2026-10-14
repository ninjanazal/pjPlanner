import { ownerLoads, ownerMetrics, projectMetrics, tally } from '../metrics';
import type { Issue, Module, Owner, Relation, Sprint } from '../types';

const t = (id: number, p: Partial<Issue> = {}): Issue => ({
  id, type: 'task', title: `T${id}`, description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});
const mod = (id: number, ownerIds: number[] = []): Module => ({
  id, name: `M${id}`, description: '', ownerIds, color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const o = (id: number): Owner => ({ id, name: `O${id}`, color: null, icon: null });
const sp = (id: number, state: Sprint['state']): Sprint => ({ id, name: `S${id}`, goal: '', state, issueIds: [], openCount: 0, closedCount: 0 });

describe('tally', () => {
  it('weights by estimate (1 when unset) and counts each state', () => {
    const r = tally([t(1, { estimate: 3, state: 'closed' }), t(2), t(3, { estimate: 2, state: 'code_review' }), t(4, { state: 'test_validation' })]);
    expect(r).toMatchObject({ tasks: 4, closed: 1, open: 1, codeReview: 1, testValidation: 1, steps: 7, doneSteps: 3, remainingSteps: 4, pct: 43 });
  });
  it('is zero for no tasks', () => expect(tally([]).pct).toBe(0));
});

describe('ownerLoads', () => {
  it('ranks by remaining steps and flags clearly overloaded owners', () => {
    const issues = [t(1, { ownerId: 1, estimate: 8 }), t(2, { ownerId: 2, estimate: 1 }), t(3, { ownerId: 3, estimate: 1 }), t(4, { ownerId: 1, state: 'closed', estimate: 5 })];
    const loads = ownerLoads(issues, [o(1), o(2), o(3)]);
    expect(loads.map((l) => l.owner.id)).toEqual([1, 2, 3]);
    expect(loads[0]).toMatchObject({ remaining: 8, open: 1, overloaded: true });
    expect(loads[0].share).toBeCloseTo(0.8);
    expect(loads[1].overloaded).toBe(false);
  });
  it('never flags a lone owner', () => expect(ownerLoads([t(1, { ownerId: 1, estimate: 9 })], [o(1)])[0].overloaded).toBe(false));
});

describe('ownerMetrics', () => {
  it('sums the owner, their active sprint load and per-module split', () => {
    const issues = [t(1, { ownerId: 1, moduleId: 1, sprintId: 1, estimate: 2 }), t(2, { ownerId: 1, moduleId: 2, state: 'closed' }), t(3, { ownerId: 2, moduleId: 1, sprintId: 1 })];
    const m = ownerMetrics(issues, [o(1), o(2)], [mod(1), mod(2)], [sp(1, 'active')], 1);
    expect(m.tally).toMatchObject({ tasks: 2, closed: 1, remainingSteps: 2, pct: 33 });
    expect(m).toMatchObject({ rank: 1, ownerCount: 2, activeSprintSteps: 2, activeSprintName: 'S1', avgSteps: 1.5 });
    expect(m.share).toBeCloseTo(2 / 3);
    expect(m.perModule.map((r) => r.module.id)).toEqual([1, 2]);
  });
});

describe('projectMetrics', () => {
  const issues: Issue[] = [
    { ...t(1), type: 'epic' }, { ...t(2), type: 'story', parentId: 1 },
    t(3, { parentId: 2, moduleId: 1, sprintId: 1, ownerId: 1, estimate: 2, state: 'closed' }),
    t(4, { parentId: 2, moduleId: 1, sprintId: 1 }), t(5, { moduleId: 2, state: 'code_review', ownerId: 2 }),
    { ...t(6), type: 'bug' },
  ];
  const rels: Relation[] = [{ id: 1, sourceId: 2, targetId: 1, label: null, color: null }];
  const m = projectMetrics(issues, [o(1), o(2)], [mod(1, [1]), mod(2)], [sp(2, 'planned'), sp(1, 'active')], rels);
  it('counts tasks, in-flight work and gaps', () => {
    expect(m.tasks).toMatchObject({ tasks: 3, closed: 1, steps: 4, doneSteps: 2, pct: 50 });
    expect(m).toMatchObject({ inFlight: 1, unassignedOpen: 1, backlogOpen: 1, unestimatedOpen: 2 });
    expect(m.byType.bug).toEqual({ total: 1, closed: 0 });
  });
  it('orders sprints active first and reports module dependents and owner gaps', () => {
    expect(m.sprints.map((s) => s.sprint.id)).toEqual([1, 2]);
    expect(m.modules.find((x) => x.module.id === 1)!.dependents).toBe(1);
    expect(m.modulesWithoutOwner.map((x) => x.id)).toEqual([2]);
  });
  it('rolls an epic up through its story to the tasks below', () => {
    expect(m.epics[0].tally).toMatchObject({ tasks: 2, closed: 1, pct: 67 });
  });
});
