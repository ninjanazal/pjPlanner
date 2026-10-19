import { formatDuration, timeMetrics } from '../metrics';
import type { Issue, Module, Owner } from '../types';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const H = 3_600_000, D = 24 * H;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
// created `age` ago, closed after `lead` (so closed `age - lead` ago)
const done = (id: number, p: { owner: number; module: number; age: number; lead: number; estimate?: number; reopens?: number }): Issue => ({
  id, type: 'task', title: `T${id}`, description: '', parentId: null, ownerId: p.owner, state: 'closed', moduleId: p.module, sprintId: null, childIds: [], rollupModuleIds: [],
  estimate: p.estimate ?? null, createdAt: iso(p.age), closedAt: iso(p.age - p.lead), closedOwnerId: p.owner, reopenCount: p.reopens ?? 0, updatedAt: iso(p.age - p.lead),
});
const open = (id: number, p: { module: number; age: number; touched?: number }): Issue => ({
  id, type: 'task', title: `O${id}`, description: '', parentId: null, ownerId: null, state: 'open', moduleId: p.module, sprintId: null, childIds: [], rollupModuleIds: [],
  createdAt: iso(p.age), updatedAt: iso(p.touched ?? p.age),
});
const o = (id: number): Owner => ({ id, name: `O${id}`, color: null, icon: null });
const mod = (id: number): Module => ({ id, name: `M${id}`, description: '', color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null });

describe('formatDuration', () => {
  it('picks a readable unit', () => {
    expect(formatDuration(20 * 60_000)).toBe('20 min');
    expect(formatDuration(3 * H)).toBe('3.0 h');
    expect(formatDuration(30 * H)).toBe('30 h');
    expect(formatDuration(3 * D)).toBe('3.0 d');
    expect(formatDuration(NaN)).toBe('–');
  });
});

describe('timeMetrics', () => {
  const issues = [
    done(1, { owner: 1, module: 1, age: 10 * D, lead: 2 * D }),               // 2 d, 1 step
    done(2, { owner: 1, module: 1, age: 9 * D, lead: 4 * D, estimate: 2 }),   // 4 d, 2 steps
    done(3, { owner: 2, module: 2, age: 8 * D, lead: 8 * D, reopens: 1 }),    // 8 d, 1 step
    done(4, { owner: 2, module: 2, age: 7 * D, lead: 6 * D }),                // 6 d, 1 step
    open(5, { module: 3, age: 30 * D }),                                      // cold: untouched for a month
    open(6, { module: 1, age: 3 * D, touched: 1 * D }),
  ];
  const m = timeMetrics(issues, [o(1), o(2)], [mod(1), mod(2), mod(3)], NOW);

  it('averages lead time, per step and age', () => {
    expect(m.closedCount).toBe(4);
    expect(m.avgLeadMs).toBeCloseTo(5 * D); // (2+4+8+6)/4
    expect(m.medianLeadMs).toBeCloseTo(5 * D);
    expect(m.msPerStep).toBeCloseTo(20 * D / 5); // 20 days of lead over 5 steps
    expect(m.oldestOpen).toMatchObject({ ageMs: 30 * D });
    expect(m.reopenRate).toBeCloseTo(1 / 5);
    expect(m.reopenedTasks).toBe(1);
  });
  it('names the faster owner per step', () => {
    expect(m.owners.map((r) => [r.owner.id, r.fastest])).toEqual([[1, true], [2, false]]);
    expect(m.owners[0].msPerStep).toBeCloseTo(2 * D); // 6 days over 3 steps
  });
  it('finds the quickest and slowest module, hottest and coldest', () => {
    const by = (id: number) => m.modules.find((x) => x.module.id === id)!;
    expect(by(1).quickest).toBe(true);
    expect(by(2).slowest).toBe(true);
    expect(by(1).hottest).toBe(true); // closed work in the last 14 days, and a touched open task
    expect(by(3).coldest).toBe(true);
    expect(by(3).idleDays).toBe(30);
  });
  it('buckets throughput into weekly windows ending now', () => {
    expect(m.weeks).toHaveLength(8);
    expect(m.weeks.reduce((n, w) => n + w.closed, 0)).toBe(4);
    expect(m.weeks.reduce((n, w) => n + w.created, 0)).toBe(6);
  });
  it('leaves out tasks with no recorded close time and needs two to rank', () => {
    const noTime: Issue = { ...done(9, { owner: 1, module: 1, age: D, lead: H }), closedAt: null };
    const r = timeMetrics([noTime, done(1, { owner: 1, module: 1, age: 5 * D, lead: D })], [o(1), o(2)], [mod(1)], NOW);
    expect(r.closedCount).toBe(1);
    expect(r.owners.some((x) => x.fastest)).toBe(false);
  });
});
