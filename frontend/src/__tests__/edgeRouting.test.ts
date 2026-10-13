import { END_SPREAD, SIDE_INSET, bendOrder, chooseSides, labelWidth, markerFor, nudgeLabels, routeEdges, slideAlong, tipPoint, TIP_GAP, BEND_GAP } from '../edgeRouting';

const box = (id: number, x: number, y: number, w = 200, h = 80) => ({ id: String(id), x, y, w, h });
const rel = (id: number, s: number, t: number, label?: string) => ({ id, sourceId: s, targetId: t, label });

describe('edgeRouting', () => {
  it('chooses the facing sides on the dominant axis', () => {
    expect(chooseSides(box(1, 0, 0), box(2, 400, 0))).toEqual({ sp: 'right', tp: 'left' });
    expect(chooseSides(box(1, 400, 0), box(2, 0, 0))).toEqual({ sp: 'left', tp: 'right' });
    expect(chooseSides(box(1, 0, 0), box(2, 20, 300))).toEqual({ sp: 'bottom', tp: 'top' });
    expect(chooseSides(box(1, 0, 300), box(2, 20, 0))).toEqual({ sp: 'top', tp: 'bottom' });
    expect(chooseSides(box(1, 0, 0), box(2, 300, 100)).sp).toBe('right'); // diagonal: larger gap wins
  });

  it('centres a single attachment on the side', () => {
    expect(slideAlong(80, [40])).toEqual([40]);
    expect(slideAlong(80, [-500])).toEqual([40]);
    expect(slideAlong(200, [999])).toEqual([100]);
  });

  it('spreads endpoints sharing one side symmetrically around the midpoint, keeping their order', () => {
    const p = slideAlong(200, [100, 100, 100]);
    expect(p[1] - p[0]).toBeCloseTo(END_SPREAD); expect(p[2] - p[1]).toBeCloseTo(END_SPREAD);
    expect((p[0] + p[2]) / 2).toBeCloseTo(100); expect(p[1]).toBeCloseTo(100);
    const e = slideAlong(200, [1, 2]);
    expect((e[0] + e[1]) / 2).toBeCloseTo(100);
    const q = slideAlong(200, [150, 20, 90]);
    expect(q[1]).toBeLessThan(q[2]); expect(q[2]).toBeLessThan(q[0]);
    const tight = slideAlong(40, [5, 5, 5, 5]); // spacing shrinks to fit
    expect(Math.min(...tight)).toBeGreaterThanOrEqual(8); expect(Math.max(...tight)).toBeLessThanOrEqual(32);
    expect(tight[0] + tight[3]).toBeCloseTo(40);
  });

  it('attaches a lone edge at the midpoint of both sides, on every side', () => {
    const mid = (r: ReturnType<typeof routeEdges> extends Map<number, infer R> ? R : never) => r;
    const cases: [number, number][] = [[400, 0], [-400, 0], [20, 300], [20, -300], [400, 150], [-300, -250]];
    cases.forEach(([dx, dy]) => {
      const a = box(1, 1000, 1000, 200, 80); const b = box(2, 1000 + dx, 1000 + dy, 160, 120);
      const r = mid(routeEdges([a, b], [rel(1, 1, 2)]).get(1)!);
      const c = (bx: typeof a, side: string) => (side === 'left' || side === 'right' ? bx.y + bx.h / 2 : bx.x + bx.w / 2);
      const horiz = (side: string) => side === 'left' || side === 'right';
      expect(horiz(r.sp) ? r.sy : r.sx).toBeCloseTo(c(a, r.sp));
      expect(horiz(r.tp) ? r.ty : r.tx).toBeCloseTo(c(b, r.tp));
    });
  });

  it('orders bends farthest-first, upward edges before downward', () => {
    const o = bendOrder([{ id: 1, self: 100, other: 0 }, { id: 2, self: 100, other: 60 }, { id: 3, self: 100, other: 200 }, { id: 4, self: 100, other: 300 }]);
    expect([1, 2, 4, 3].map((i) => o.get(i))).toEqual([0, 1, 2, 3]);
  });

  it('nudges colliding labels apart along the segment', () => {
    const w = labelWidth('Boots');
    const out = nudgeLabels([
      { id: 1, a: 500, b: 100, len: w, wid: 24, min: 0 }, { id: 2, a: 500, b: 106, len: w, wid: 24, min: 0 }, { id: 3, a: 500, b: 300, len: w, wid: 24, min: 0 },
    ]);
    expect(Math.abs(out.get(1)! - out.get(2)!)).toBeGreaterThanOrEqual(w);
    expect(out.get(3)).toBe(500);
  });

  it('routes side-by-side cards right to left, and stacked cards bottom to top', () => {
    const h = routeEdges([box(1, 0, 0), box(2, 400, 0)], [rel(1, 1, 2)]).get(1)!;
    expect([h.sp, h.tp, h.sx, h.tx]).toEqual(['right', 'left', 200, 400]);
    expect(h.sy).toBe(40); expect(h.ty).toBe(40);
    const v = routeEdges([box(1, 0, 0), box(2, 20, 300)], [rel(1, 1, 2)]).get(1)!;
    expect([v.sp, v.tp, v.sy, v.ty]).toEqual(['bottom', 'top', 80, 300]);
    const up = routeEdges([box(1, 0, 300), box(2, 0, 0)], [rel(1, 1, 2)]).get(1)!;
    expect([up.sp, up.tp]).toEqual(['top', 'bottom']);
  });

  it('shares one exit point and bend column across several targets, labels before the arrow', () => {
    const boxes = [box(1, 0, 200), box(2, 400, 0), box(3, 400, 200), box(4, 400, 400)];
    const r = routeEdges(boxes, [2, 3, 4].map((t) => rel(t, 1, t, 'Boots')));
    const rs = [2, 3, 4].map((i) => r.get(i)!);
    expect(new Set(rs.map((x) => x.sy)).size).toBe(1);
    expect(new Set(rs.map((x) => x.centerX)).size).toBe(1);
    expect(new Set(rs.map((x) => x.ty)).size).toBe(3);
    [2, 3, 4].forEach((i) => { const l = r.get(i)!.label!; expect(l.x + l.w / 2).toBeLessThanOrEqual(400); });
  });

  it('adding a connection does not move a trunk: one exit at the side midpoint, one bend column', () => {
    const boxes = [box(1, 0, 200, 200, 200), ...[0, 1, 2, 3, 4, 5].map((i) => box(10 + i, 500, i * 120))];
    const r = routeEdges(boxes, [0, 1, 2, 3, 4, 5].map((i) => rel(i + 1, 1, 10 + i)));
    const rs = [1, 2, 3, 4, 5, 6].map((i) => r.get(i)!);
    rs.forEach((x) => expect(x.sy).toBeCloseTo(300));
    expect(new Set(rs.map((x) => x.centerX)).size).toBe(1);
  });

  it('spaces many endpoints on a tall side by at least END_SPREAD', () => {
    const p = slideAlong(300, [150, 150, 150, 150, 150]);
    for (let i = 1; i < 5; i++) expect(p[i] - p[i - 1]).toBeGreaterThanOrEqual(END_SPREAD - 0.01);
  });

  it('ends the arrow tip TIP_GAP outside the target border', () => {
    expect(tipPoint({ tx: 400, ty: 40, tp: 'left' })).toEqual({ x: 400 - TIP_GAP, y: 40 });
    expect(tipPoint({ tx: 400, ty: 40, tp: 'right' })).toEqual({ x: 400 + TIP_GAP, y: 40 });
    expect(tipPoint({ tx: 5, ty: 300, tp: 'top' })).toEqual({ x: 5, y: 300 - TIP_GAP });
    expect(tipPoint({ tx: 5, ty: 300, tp: 'bottom' })).toEqual({ x: 5, y: 300 + TIP_GAP });
    expect(markerFor('#f00').width).toBeLessThanOrEqual(14);
  });

  it('keeps reverse pairs in separate parallel lanes', () => {
    const r = routeEdges([box(1, 0, 0), box(2, 400, 0)], [rel(1, 1, 2), rel(2, 2, 1)]);
    const a = r.get(1)!; const b = r.get(2)!;
    expect(a.sy).not.toBe(b.sy);
    expect(b.sp).toBe('left'); expect(a.sp).toBe('right');
    expect(Math.sign(a.sy - b.ty)).toBe(Math.sign(a.sy - b.ty)); // same lane order at both ends
    expect(a.sy - b.ty).toBeLessThan(0); expect(b.sy - a.ty).toBeGreaterThan(0);
  });

  it('keeps vertical reverse pairs and labels apart', () => {
    const r = routeEdges([box(1, 0, 0), box(2, 0, 300)], [rel(1, 1, 2, 'A'), rel(2, 2, 1, 'B')]);
    expect(r.get(1)!.sx).not.toBe(r.get(2)!.sx);
    expect(r.get(1)!.label).not.toEqual(r.get(2)!.label);
  });

  it('ignores self links and unknown cards', () => {
    expect(routeEdges([box(1, 0, 0)], [rel(1, 1, 1), rel(2, 1, 9)]).size).toBe(0);
  });

  it('builds a per-colour marker, defaulting to the theme variable and blue when selected', () => {
    expect(markerFor('#ff0000').color).toBe('#ff0000');
    expect(markerFor(null).color).toBe('var(--edge)');
    expect(markerFor('#ff0000', true).color).toBe('#4f7cff');
  });
});

describe('routing around a card in front of the target', () => {
  it('never runs a segment through another card', () => {
    // Wallet above Eaner (same width); Genisys far below-left links up to Wallet.
    const boxes = [box(1, 262, 100, 212, 80), box(2, 262, 225, 212, 60), box(3, 58, 500, 212, 60), box(4, 200, 110, 40, 40)]; // 4 also blocks the left side
    const r = routeEdges(boxes, [rel(1, 3, 1)]).get(1)!;
    expect(r.path).toBeDefined();
    const eaner = boxes[1];
    r.path!.slice(1).forEach((q, i) => {
      const a = r.path![i];
      const crosses = Math.max(a.x, q.x) > eaner.x && Math.min(a.x, q.x) < eaner.x + eaner.w && Math.max(a.y, q.y) > eaner.y && Math.min(a.y, q.y) < eaner.y + eaner.h;
      expect(crosses).toBe(false);
    });
  });
  it('leaves clear edges as plain step paths', () => {
    expect(routeEdges([box(1, 0, 0), box(2, 400, 0)], [rel(1, 1, 2)]).get(1)!.path).toBeUndefined();
  });
});

describe('entering from the open side', () => {
  it('uses the free horizontal side instead of looping round a card below the target', () => {
    const boxes = [box(1, 262, 100, 212, 80), box(2, 262, 225, 212, 60), box(3, 58, 500, 212, 60)];
    const r = routeEdges(boxes, [rel(1, 3, 1)]).get(1)!;
    expect(r.tp).toBe('left'); expect(r.path).toBeUndefined();
  });
});
