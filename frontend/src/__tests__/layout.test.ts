import { describe, expect, it } from 'vitest';
import { autoLayout, cardHeight, cardWidth } from '../layout';
import { HUB_MIN_DEPENDANTS } from '../linkFocus';
import type { Graph, Module } from '../types';

const mod = (id: number): Module => ({
  id, name: `M${id}`, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const rel = (id: number, sourceId: number, targetId: number) => ({ id, sourceId, targetId, label: null, color: null });
const rect = (m: Module, p: { x: number; y: number }) => ({ ...p, w: cardWidth(m.name, m.icon), h: cardHeight(0) });
const overlap = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('autoLayout readability', () => {
  // 1 is a shared foundation; 2..9 depend on it; 10-11 and 12 are separate small clusters; 13 is unconnected.
  const dependants = Array.from({ length: HUB_MIN_DEPENDANTS }, (_, i) => i + 2);
  const graph: Graph = {
    owners: [], groups: [],
    modules: Array.from({ length: 13 }, (_, i) => mod(i + 1)),
    relations: [...dependants.map((d, i) => rel(i + 1, d, 1)), rel(20, 2, 3), rel(21, 10, 11), rel(22, 12, 11)],
  };
  const pos = autoLayout(graph);
  const rects = new Map(graph.modules.map((m) => [m.id, rect(m, pos.get(m.id)!)]));

  it('never overlaps two cards', () => {
    const list = [...rects.values()];
    list.forEach((a, i) => list.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
  });

  it('parks the shared foundation to the right of every other card', () => {
    const hub = rects.get(1)!;
    [...rects].filter(([id]) => id !== 1).forEach(([, r]) => expect(r.x + r.w).toBeLessThanOrEqual(hub.x));
  });

  it('keeps a dependency chain flowing left to right', () => {
    expect(rects.get(2)!.x).toBeLessThan(rects.get(3)!.x);
    expect(rects.get(10)!.x).toBeLessThan(rects.get(11)!.x);
  });
});

describe('autoLayout arrows', () => {
  // 1 -> 2 -> 3 -> 4 is a chain; 1 -> 4 and 1 -> 3 skip ranks and must not run through the cards between.
  const graph: Graph = {
    owners: [], groups: [],
    modules: [1, 2, 3, 4, 5, 6].map(mod),
    relations: [rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 4), rel(4, 1, 4), rel(5, 1, 3), rel(6, 1, 5), rel(7, 5, 6), rel(8, 6, 4)],
  };
  it('keeps straight links out of unrelated cards', () => {
    const pos = autoLayout(graph);
    const r = new Map(graph.modules.map((m) => [m.id, rect(m, pos.get(m.id)!)]));
    const c = (id: number) => ({ x: r.get(id)!.x + r.get(id)!.w / 2, y: r.get(id)!.y + r.get(id)!.h / 2 });
    let hits = 0;
    for (const e of graph.relations) {
      const a = c(e.sourceId); const b = c(e.targetId);
      for (const m of graph.modules) {
        if (m.id === e.sourceId || m.id === e.targetId) continue;
        const q = r.get(m.id)!;
        for (let t = 0; t <= 1; t += 0.01) {
          const x = a.x + (b.x - a.x) * t; const y = a.y + (b.y - a.y) * t;
          if (x > q.x && x < q.x + q.w && y > q.y && y < q.y + q.h) { hits++; break; }
        }
      }
    }
    expect(hits).toBe(0);
  });
});
