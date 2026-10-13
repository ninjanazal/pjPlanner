import { heatColor, sprintHeat } from '../heatmap';
import { epicOf } from '../sprintGroups';
import type { Issue } from '../types';

const mk = (id: number, p: Partial<Issue> = {}): Issue => ({
  id, type: 'task', title: `t${id}`, description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});

describe('heatmap', () => {
  it('counts a sprint\'s tasks per module, relative to the busiest', () => {
    const h = sprintHeat([
      mk(1, { sprintId: 1, moduleId: 1 }), mk(2, { sprintId: 1, moduleId: 1 }), mk(3, { sprintId: 1, moduleId: 1, state: 'closed' }),
      mk(4, { sprintId: 1, moduleId: 2 }), mk(5, { sprintId: 2, moduleId: 2 }), mk(6, { sprintId: 1 }), mk(7, { type: 'bug', sprintId: 1, moduleId: 3 }),
    ], 1);
    expect(h.get(1)).toEqual({ open: 2, done: 1, level: 1 });
    expect(h.get(2)).toEqual({ open: 1, done: 0, level: 0.5 });
    expect(h.has(3)).toBe(false);
    expect(heatColor(0)).not.toBe(heatColor(1));
  });
  it('finds a task\'s epic directly or through a bug or a story', () => {
    const all = [mk(1, { type: 'epic' }), mk(2, { type: 'bug', parentId: 1 }), mk(3, { parentId: 2 }), mk(4, { parentId: 1 }), mk(5),
      mk(6, { type: 'story', parentId: 1 }), mk(7, { parentId: 6 }), mk(8, { type: 'story' }), mk(9, { parentId: 8 })];
    expect([3, 4, 5, 7, 9].map((i) => epicOf(all.find((x) => x.id === i)!, all)?.id)).toEqual([1, 1, undefined, 1, undefined]);
  });
});

import { ownerMap } from '../heatmap';
describe('ownerMap', () => {
  it('marks owned modules and counts the person\'s tasks in live sprints', () => {
    const modules = [{ id: 1, ownerIds: [5] }, { id: 2, ownerIds: [] }, { id: 3, ownerIds: [] }] as never[];
    const sprints = [{ id: 1, state: 'active' }, { id: 2, state: 'closed' }] as never[];
    const m = ownerMap([
      mk(1, { ownerId: 5, moduleId: 2, sprintId: 1 }), mk(2, { ownerId: 5, moduleId: 2, sprintId: 1, state: 'closed' }),
      mk(3, { ownerId: 5, moduleId: 3, sprintId: 2 }), mk(4, { ownerId: 6, moduleId: 1, sprintId: 1 }),
    ], modules, sprints, 5, null);
    expect(m.get(1)).toMatchObject({ owned: true, open: 0, done: 0 });
    expect(m.get(2)).toMatchObject({ owned: false, open: 1, done: 1 });
    expect(m.get(3)).toMatchObject({ owned: false, open: 0, done: 0 }); // closed sprint is history
  });
});
