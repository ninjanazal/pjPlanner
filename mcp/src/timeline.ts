// Same scheduler as frontend/src/sprintTimeline.ts (the packages are independent): keep them in sync.
export interface Issue { id: number; title: string; state: string; ownerId: number | null; moduleId: number | null; estimate?: number | null }
export interface Module { id: number }
export interface Relation { sourceId: number; targetId: number }

export interface Slot { issue: Issue; lane: number | null; start: number; length: number; waitsFor: number[] }
export interface Timeline { slots: Slot[]; lanes: (number | null)[]; length: number; idealLength: number }

// Every module a module depends on, directly or not (relation source -> target = source depends on target).
function upstream(moduleId: number, relations: Relation[]): Set<number> {
  const seen = new Set<number>();
  const queue = [moduleId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const r of relations) if (r.sourceId === cur && r.targetId !== moduleId && !seen.has(r.targetId)) { seen.add(r.targetId); queue.push(r.targetId); }
  }
  return seen;
}

// A task takes its estimate in steps (1 when unset). It waits for the open tasks of every module its module depends on;
// each owner works one task at a time, preferring the task with the longest chain of work waiting behind it,
// so blocked people start what they can.
export function buildTimeline(tasks: Issue[], modules: Module[], relations: Relation[]): Timeline {
  const open = tasks.filter((t) => t.state === 'open');
  const len = (t: Issue) => Math.max(1, t.estimate ?? 1);
  const up = new Map(modules.map((m) => [m.id, upstream(m.id, relations)]));
  // Modules that depend on each other in a cycle cannot be ordered: ignore that dependency.
  const needs = (a: Issue, b: Issue) =>
    a.moduleId != null && b.moduleId != null && a.moduleId !== b.moduleId &&
    !!up.get(a.moduleId)?.has(b.moduleId) && !up.get(b.moduleId)?.has(a.moduleId);
  const deps = new Map(open.map((t) => [t.id, open.filter((o) => needs(t, o)).map((o) => o.id)]));

  const chain = new Map<number, number>(); // effort of the longest run of tasks that wait on this one, itself included
  const depth = (t: Issue): number => {
    if (chain.has(t.id)) return chain.get(t.id)!;
    const n = len(t) + Math.max(0, ...open.filter((o) => deps.get(o.id)!.includes(t.id)).map(depth));
    chain.set(t.id, n);
    return n;
  };
  open.forEach(depth);

  const lanes = [...new Set(open.map((t) => t.ownerId))].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const start = new Map<number, number>();
  const freeAt = new Map(lanes.map((l) => [l, 0]));
  const finish = (id: number) => start.get(id)! + len(open.find((t) => t.id === id)!);
  for (let step = 0; start.size < open.length; step++) {
    for (const lane of lanes) {
      if (freeAt.get(lane)! > step) continue;
      const ready = open
        .filter((t) => t.ownerId === lane && !start.has(t.id) && deps.get(t.id)!.every((d) => start.has(d) && finish(d) <= step))
        .sort((a, b) => chain.get(b.id)! - chain.get(a.id)! || a.id - b.id);
      if (ready[0]) { start.set(ready[0].id, step); freeAt.set(lane, step + len(ready[0])); }
    }
  }
  const slots = open.map((issue) => ({ issue, lane: issue.ownerId, start: start.get(issue.id)!, length: len(issue), waitsFor: deps.get(issue.id)! }));
  const length = Math.max(0, ...slots.map((s) => s.start + s.length));
  const idealLength = Math.max(0, ...lanes.map((l) => open.filter((t) => t.ownerId === l).reduce((n, t) => n + len(t), 0)));
  return { slots, lanes, length, idealLength };
}
