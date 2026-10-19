import { describe, expect, it } from 'vitest';
import { buildTimeline, criticalPath, laneGaps } from '../sprintTimeline';
import type { Issue, Module, Relation } from '../types';

const mod = (id: number) => ({ id } as Module);
const task = (id: number, moduleId: number, ownerId: number | null, estimate: number | null = null): Issue =>
  ({ id, type: 'task', title: `t${id}`, state: 'open', moduleId, ownerId, sprintId: 1, estimate } as Issue);

describe('buildTimeline', () => {
  it('makes the owner of a dependent module wait for the dependency', () => {
    // A -> B means B waits for A: owner 2's task comes after owner 1's.
    const rel: Relation[] = [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }];
    const tl = buildTimeline([task(10, 1, 1), task(11, 2, 2)], [mod(1), mod(2)], rel);
    const start = (id: number) => tl.slots.find((s) => s.issue.id === id)!.start;
    expect(start(10)).toBe(0);
    expect(start(11)).toBe(1);
    expect(tl.length).toBe(2);
  });
  it('lets independent work run in parallel and starts blocked owners on free tasks', () => {
    const rel: Relation[] = [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }];
    const tl = buildTimeline([task(10, 1, 1), task(11, 2, 2), task(12, 3, 2)], [mod(1), mod(2), mod(3)], rel);
    expect(tl.slots.find((s) => s.issue.id === 12)!.start).toBe(0);
    expect(tl.slots.find((s) => s.issue.id === 11)!.start).toBe(1);
  });
  it('uses estimates as durations', () => {
    const rel: Relation[] = [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }];
    const tl = buildTimeline([task(10, 1, 1, 3), task(11, 2, 2, 2)], [mod(1), mod(2)], rel);
    expect(tl.slots.find((s) => s.issue.id === 11)).toMatchObject({ start: 3, length: 2 });
    expect(tl.length).toBe(5);
  });
  it('survives dependency cycles', () => {
    const rel: Relation[] = [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }, { id: 2, sourceId: 2, targetId: 1, label: null, color: null }];
    expect(buildTimeline([task(10, 1, 1), task(11, 2, 2)], [mod(1), mod(2)], rel).length).toBe(1);
  });
});

describe('laneGaps and criticalPath', () => {
  const rel: Relation[] = [{ id: 1, sourceId: 1, targetId: 2, label: null, color: null }];
  const tl = buildTimeline([task(10, 1, 1, 2), task(11, 2, 2), task(12, 1, 2)], [mod(1), mod(2)], rel);

  it('reports the idle stretch of a waiting owner', () => {
    // owner 2 does #12 at step 0, then idles at step 1 until #10 finishes at 2.
    expect(laneGaps(tl)).toEqual([{ lane: 2, start: 1, length: 1 }]);
  });

  it('marks the chain that sets the finish', () => {
    expect([...criticalPath(tl)].sort()).toEqual([10, 11]);
  });
});
