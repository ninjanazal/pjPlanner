// Pure geometry for diagram edges: orthogonal step paths that attach to any card side, with sliding
// attachment points, spread lanes, staggered bends and label placement.
export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Box { id: string; x: number; y: number; w: number; h: number }
export interface Rel { id: number; sourceId: number; targetId: number; label?: string | null }
export interface Route {
  sx: number; sy: number; tx: number; ty: number; sp: Side; tp: Side;
  centerX: number; centerY: number; label: { x: number; y: number; w: number } | null;
  path?: { x: number; y: number }[]; // explicit waypoints when the plain step path would cross a card
}

export const BEND_GAP = 14;
export const END_SPREAD = 14;
export const ARROW_LEN = 14;
export const LABEL_H = 24;
export const SIDE_INSET = 20;
export const TIP_GAP = 4;
const LABEL_CHAR_W = 7.9;
const LABEL_PAD = 22;

export function labelWidth(text: string): number {
  return Math.ceil([...text].length * LABEL_CHAR_W + LABEL_PAD);
}

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

// Sides facing each other: the axis with the larger gap wins, horizontal favoured 2:1 (centres decide when overlapping).
export function chooseSides(s: Box, t: Box): { sp: Side; tp: Side } {
  const dx = t.x + t.w / 2 - (s.x + s.w / 2); const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const gapX = Math.abs(dx) - (s.w + t.w) / 2; const gapY = Math.abs(dy) - (s.h + t.h) / 2;
  const horiz = gapX > 0 ? gapX * 2 >= gapY : gapY > 0 ? false : Math.abs(dx) / (s.w + t.w) >= Math.abs(dy) / (s.h + t.h);
  const sp: Side = horiz ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
  return { sp, tp: OPPOSITE[sp] };
}

// A card sitting in the strip right in front of the target's side (towards the source) would be run through
// or force a detour; `others` are all cards but the two ends.
const blockedFront = (t: Box, tp: Side, s: Box, others: Box[]): boolean => {
  const h = tp === 'left' || tp === 'right';
  const toward = h ? (s.x + s.w / 2 >= t.x + t.w / 2 ? 1 : -1) : (s.y + s.h / 2 >= t.y + t.h / 2 ? 1 : -1);
  return others.some((b) => {
    if (h) {
      const front = toward > 0 ? b.x + b.w > t.x + t.w : b.x < t.x;
      const near = toward > 0 ? b.x < s.x + s.w / 2 : b.x + b.w > s.x + s.w / 2;
      return front && near && b.y < t.y + t.h && b.y + b.h > t.y;
    }
    const front = toward > 0 ? b.y + b.h > t.y + t.h : b.y < t.y;
    const near = toward > 0 ? b.y < s.y + s.h / 2 : b.y + b.h > s.y + s.h / 2;
    return front && near && b.x < t.x + t.w && b.x + b.w > t.x;
  });
};

// Like chooseSides, but when a card blocks the way into the chosen target side it switches to the other axis
// (if that one is clear), so the line comes in from the open side instead of looping round the blocker.
export function chooseClearSides(s: Box, t: Box, others: Box[]): { sp: Side; tp: Side } {
  const first = chooseSides(s, t);
  if (!blockedFront(t, first.tp, s, others)) return first;
  const dx = t.x + t.w / 2 - (s.x + s.w / 2); const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const wasH = first.sp === 'left' || first.sp === 'right';
  const sp: Side = wasH ? (dy >= 0 ? 'bottom' : 'top') : (dx >= 0 ? 'right' : 'left');
  const alt = { sp, tp: OPPOSITE[sp] };
  return blockedFront(t, alt.tp, s, others) ? first : alt;
}

// Positions (along a side of length `len`, starting at 0) for endpoints sharing that side. They are centred:
// one endpoint sits at the midpoint; N are spread symmetrically around it, `END_SPREAD` apart (less if the side
// is short), kept off the corners. `ideals` (the other end's position) only decides the order, so lines do not cross.
export function slideAlong(len: number, ideals: number[]): number[] {
  const n = ideals.length;
  const mid = len / 2;
  const margin = Math.min(8, len / 2);
  const gap = n > 1 ? Math.min(END_SPREAD, Math.max(0, (len - 2 * margin) / (n - 1))) : 0;
  const order = ideals.map((v, i) => i).sort((a, b) => ideals[a] - ideals[b] || a - b);
  const out = new Array<number>(n);
  order.forEach((i, k) => { out[i] = mid + (k - (n - 1) / 2) * gap; });
  return out;
}

// Rank (0..n-1) of edges fanning out of one point: far-before edges first, so trunks do not cross.
export function bendOrder(items: { id: number; self: number; other: number }[]): Map<number, number> {
  const up = items.filter((i) => i.other < i.self).sort((a, b) => a.other - b.other || a.id - b.id);
  const down = items.filter((i) => i.other >= i.self).sort((a, b) => b.other - a.other || a.id - b.id);
  return new Map([...up, ...down].map((it, k) => [it.id, k]));
}

// Shifts overlapping label rects back along their segment (a = coordinate along travel, b = across).
export function nudgeLabels(
  labels: { id: number; a: number; b: number; len: number; wid: number; min: number }[],
): Map<number, number> {
  const placed: { a: number; b: number; len: number; wid: number }[] = [];
  const out = new Map<number, number>();
  [...labels].sort((p, q) => q.a - p.a || p.id - q.id).forEach((l) => {
    let a = l.a;
    for (let guard = 0; guard < 20; guard++) {
      const hit = placed.find((p) => Math.abs(p.b - l.b) < (p.wid + l.wid) / 2 + 2 && Math.abs(p.a - a) < (p.len + l.len) / 2 + 4);
      if (!hit) break;
      a = hit.a - (hit.len + l.len) / 2 - 6;
    }
    a = Math.max(a, Math.min(l.min, l.a));
    placed.push({ a, b: l.b, len: l.len, wid: l.wid });
    out.set(l.id, a);
  });
  return out;
}

const CLEAR = 8;
const hits = (b: Box, m1: number, m2: number, p1: number, p2: number) =>
  Math.max(m1, m2) > b.x - CLEAR && Math.min(m1, m2) < b.x + b.w + CLEAR && Math.max(p1, p2) > b.y - CLEAR && Math.min(p1, p2) < b.y + b.h + CLEAR;

// Bend column (in travel-normalised coordinates: main increases toward the target, boxes use x=main, y=perp).
// The gap midpoint by default; for long edges the nearest column beside a skipped card that avoids all others.
export const columnFree = (bm: number, sm: number, sp: number, tm: number, tp: number, others: Box[]) => !others.some((b) =>
  hits(b, sm, bm, sp, sp) || hits(b, bm, tm, tp, tp) || hits(b, bm - BEND_GAP * 3, bm + BEND_GAP * 3, sp, tp));

export function pickBase(sm: number, sp: number, tm: number, tp: number, others: Box[]): number {
  const mid = sm + (tm - sm) / 2;
  const free = (bm: number) => columnFree(bm, sm, sp, tm, tp, others);
  if (free(mid)) return mid;
  const cands = others.flatMap((b) => [b.x - 60, b.x + b.w + 60]).filter((x) => x > sm + 20 && x < tm - 20)
    .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  return cands.find(free) ?? mid;
}

// When no single bend column clears every card (a card sits right in front of the target), go round it:
// out to a free row, sideways past the blocker, then in just in front of the target. Returns waypoints in the
// normalised frame (main, perp) or null if no clear way exists.
export function detourPoints(sm: number, sp: number, tm: number, tp: number, others: Box[]): { m: number; p: number }[] | null {
  const lo = Math.min(sm, tm); const hi = Math.max(sm, tm);
  const between = others.filter((b) => b.x + b.w > lo && b.x < hi);
  const approach = between.filter((b) => hits(b, sm, tm, tp, tp) || hits(b, sm, tm, sp, sp));
  if (approach.length === 0) return null;
  const bm2 = tm - (ARROW_LEN + TIP_GAP + 6);
  const nearest = Math.max(...approach.map((b) => b.x + b.w)); // blocker edge closest to the target
  if (nearest + CLEAR > bm2) return null;
  const farStart = Math.min(...approach.map((b) => b.x));
  const bm1 = Math.max(sm + 12, Math.min(sm + (farStart - sm) / 2, farStart - 14));
  const cols = approach.flatMap((b) => [b.y - 22, b.y + b.h + 22]).sort((a, b) => Math.abs(a - tp) - Math.abs(b - tp));
  const col = cols.find((c) => !others.some((b) => hits(b, bm1, bm2, c, c) || hits(b, bm1, bm1, sp, c) || hits(b, bm2, bm2, c, tp)));
  if (col === undefined) return null;
  return [{ m: sm, p: sp }, { m: bm1, p: sp }, { m: bm1, p: col }, { m: bm2, p: col }, { m: bm2, p: tp }];
}

interface End { relId: number; isSource: boolean; ideal: number; pos: number }

export function routeEdges(boxes: Box[], rels: Rel[]): Map<number, Route> {
  const by = new Map(boxes.map((b) => [Number(b.id), b]));
  const valid = rels.filter((r) => r.sourceId !== r.targetId && by.has(r.sourceId) && by.has(r.targetId));
  const horiz = (p: Side) => p === 'left' || p === 'right';
  const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  const sides = new Map(valid.map((r) => [r.id, chooseClearSides(by.get(r.sourceId)!, by.get(r.targetId)!, boxes.filter((b) => b.id !== String(r.sourceId) && b.id !== String(r.targetId)))]));
  // Endpoints grouped by (card, side); each wants to sit level with the other card, then lanes are spread.
  const groups = new Map<string, { card: number; side: Side; ends: End[] }>();
  const put = (card: number, side: Side, e: End) => {
    const key = `${card}:${side}`;
    if (!groups.has(key)) groups.set(key, { card, side, ends: [] });
    groups.get(key)!.ends.push(e);
  };
  valid.forEach((r) => {
    const { sp, tp } = sides.get(r.id)!;
    const sc = centre(by.get(r.sourceId)!); const tc = centre(by.get(r.targetId)!);
    put(r.sourceId, sp, { relId: r.id, isSource: true, ideal: horiz(sp) ? tc.y : tc.x, pos: 0 });
    put(r.targetId, tp, { relId: r.id, isSource: false, ideal: horiz(tp) ? sc.y : sc.x, pos: 0 });
  });
  const attach = new Map<string, number>(); // `${relId}:s|t` -> absolute perpendicular coordinate
  groups.forEach((g) => {
    const b = by.get(g.card)!; const h = horiz(g.side);
    const origin = h ? b.y : b.x;
    // Several edges leaving one side share a single exit point (a trunk) that branches toward each target,
    // so another connection needs no extra room at the source. Incoming ends still get their own slots.
    const srcEnds = g.ends.filter((e) => e.isSource);
    const trunk = srcEnds.length > 1;
    const slotted: { ends: End[]; ideal: number }[] = g.ends
      .filter((e) => !(trunk && e.isSource)).map((e) => ({ ends: [e], ideal: e.ideal }));
    if (trunk) slotted.push({ ends: srcEnds, ideal: srcEnds.reduce((a, e) => a + e.ideal, 0) / srcEnds.length });
    slotted.sort((p, q) => p.ideal - q.ideal || p.ends[0].relId - q.ends[0].relId);
    const pos = slideAlong(h ? b.h : b.w, slotted.map((e) => e.ideal - origin));
    slotted.forEach((e, i) => e.ends.forEach((x) => attach.set(`${x.relId}:${x.isSource ? 's' : 't'}`, origin + pos[i])));
  });

  // Bundles of edges between the same two cards (e.g. reverse pairs) get separate bend lanes.
  const pairKey = (r: Rel) => `${Math.min(r.sourceId, r.targetId)}:${Math.max(r.sourceId, r.targetId)}`;
  const bundles = new Map<string, Rel[]>();
  valid.forEach((r) => bundles.set(pairKey(r), [...(bundles.get(pairKey(r)) ?? []), r]));

  const coords = (r: Rel) => {
    const { sp, tp } = sides.get(r.id)!; const h = horiz(sp);
    const s = attach.get(`${r.id}:s`)!; const t = attach.get(`${r.id}:t`)!;
    const sb = by.get(r.sourceId)!; const tb = by.get(r.targetId)!;
    const sMain = sp === 'right' ? sb.x + sb.w : sp === 'left' ? sb.x : sp === 'bottom' ? sb.y + sb.h : sb.y;
    const tMain = tp === 'right' ? tb.x + tb.w : tp === 'left' ? tb.x : tp === 'bottom' ? tb.y + tb.h : tb.y;
    const d = sp === 'right' || sp === 'bottom' ? 1 : -1;
    return { sp, tp, h, d, sMain, tMain, sPerp: s, tPerp: t };
  };

  // Fan ranks per (card, side): edges leaving/entering the same side get distinct bend columns.
  const sRank = new Map<number, number>(); const tRank = new Map<number, number>();
  const sN = new Map<number, number>(); const tN = new Map<number, number>();
  groups.forEach((g) => {
    const b = by.get(g.card)!; const self = horiz(g.side) ? centre(b).y : centre(b).x;
    const mk = (e: End) => { const r = valid.find((v) => v.id === e.relId)!; const o = by.get(e.isSource ? r.targetId : r.sourceId)!; return { id: e.relId, self, other: horiz(g.side) ? centre(o).y : centre(o).x }; };
    const src = g.ends.filter((e) => e.isSource); const tgt = g.ends.filter((e) => !e.isSource);
    // A trunk (2+ sources on one side) shares one bend column, so its branches overlap instead of fanning out.
    bendOrder(src.map(mk)).forEach((v, k) => { sRank.set(k, src.length > 1 ? 0 : v); sN.set(k, src.length > 1 ? 1 : src.length); });
    bendOrder(tgt.map(mk)).forEach((v, k) => { tRank.set(k, tgt.length - 1 - v); tN.set(k, tgt.length); });
  });

  const routes = new Map<number, Route>();
  const pending: { id: number; a: number; b: number; len: number; wid: number; min: number; d: number; h: boolean; w: number }[] = [];
  valid.forEach((r) => {
    const c = coords(r);
    const { d, h } = c;
    // Normalised frame: main grows toward the target; boxes transform accordingly.
    const norm = (b: Box): Box => {
      const bm = h ? { m: b.x, ml: b.w, p: b.y, pl: b.h } : { m: b.y, ml: b.h, p: b.x, pl: b.w };
      return { id: b.id, x: d > 0 ? bm.m : -(bm.m + bm.ml), y: bm.p, w: bm.ml, h: bm.pl };
    };
    const others = boxes.filter((b) => Number(b.id) !== r.sourceId && Number(b.id) !== r.targetId).map(norm);
    const base = pickBase(d * c.sMain, c.sPerp, d * c.tMain, c.tPerp, others);
    const around = columnFree(base, d * c.sMain, c.sPerp, d * c.tMain, c.tPerp, others) ? null : detourPoints(d * c.sMain, c.sPerp, d * c.tMain, c.tPerp, others);
    const sNo = sN.get(r.id) ?? 1; const tNo = tN.get(r.id) ?? 1;
    let off = ((sRank.get(r.id) ?? 0) - (sNo - 1) / 2 + (tRank.get(r.id) ?? 0) - (tNo - 1) / 2) * BEND_GAP;
    const bundle = bundles.get(pairKey(r))!;
    if (bundle.length > 1) {
      // Lane = rank by attach point on the lower-id card; the lane turn direction keeps parallel edges uncrossed.
      const lowId = Math.min(r.sourceId, r.targetId);
      const lowAt = (x: Rel) => attach.get(`${x.id}:${x.sourceId === lowId ? 's' : 't'}`)!;
      const lane = [...bundle].sort((p, q) => lowAt(p) - lowAt(q) || p.id - q.id);
      const k = lane.findIndex((x) => x.id === r.id);
      const fc = centre(by.get(lowId)!); const tc = centre(by.get(Math.max(r.sourceId, r.targetId))!);
      const mainDir = (h ? tc.x - fc.x : tc.y - fc.y) >= 0 ? 1 : -1;
      const perpDir = (h ? tc.y - fc.y : tc.x - fc.x) >= 0 ? 1 : -1;
      off += d * -mainDir * perpDir * (k - (bundle.length - 1) / 2) * BEND_GAP;
    }
    // base/off live in the normalised frame; convert back to absolute.
    const bendAbs = d * (base + off);
    const sx = h ? c.sMain : c.sPerp; const sy = h ? c.sPerp : c.sMain;
    const tx = h ? c.tMain : c.tPerp; const ty = h ? c.tPerp : c.tMain;
    const centerX = h ? bendAbs : (sx + tx) / 2; const centerY = h ? (sy + ty) / 2 : bendAbs;
    routes.set(r.id, { sx, sy, tx, ty, sp: c.sp, tp: c.tp, centerX, centerY, label: null });
    if (around) {
      const abs = (q: { m: number; p: number }) => (h ? { x: d * q.m, y: q.p } : { x: q.p, y: d * q.m });
      const route = routes.get(r.id)!;
      route.path = [...around.map(abs), tipPoint(route)];
      if (r.label) {
        let best = 0; let at = { x: 0, y: 0 };
        route.path.slice(1).forEach((q, i) => { const a = route.path![i]; const len = Math.abs(q.x - a.x) + Math.abs(q.y - a.y); if (len > best) { best = len; at = { x: (a.x + q.x) / 2, y: (a.y + q.y) / 2 }; } });
        route.label = { x: at.x, y: at.y, w: labelWidth(r.label) };
      }
      return;
    }
    if (r.label) {
      const w = labelWidth(r.label); const len = h ? w : LABEL_H; const wid = h ? LABEL_H : w;
      const tN2 = d * c.tMain; const sN2 = d * c.sMain;
      let a = tN2 - ARROW_LEN - 6 - len / 2;
      if (a - len / 2 < sN2 + 4) a = (sN2 + tN2) / 2; // too tight for the last stretch: centre in the gap
      pending.push({ id: r.id, a, b: c.tPerp, len, wid, min: d * bendAbs + 6 + len / 2, d, h, w });
    }
  });
  const as = nudgeLabels(pending);
  pending.forEach((p) => {
    const main = p.d * as.get(p.id)!; const perp = p.b;
    routes.get(p.id)!.label = { x: p.h ? main : perp, y: p.h ? perp : main, w: p.w };
  });
  return routes;
}

export const EDGE_SELECTED = '#4f7cff';
// Arrow-head marker for a relation colour; null falls back to the theme's edge colour variable.
export function markerFor(color: string | null | undefined, selected = false) {
  return { type: 'arrowclosed' as const, width: 14, height: 14, color: selected ? EDGE_SELECTED : (color ?? 'var(--edge)') };
}

// Where the path (and so the arrow tip) ends: TIP_GAP px outside the target border, along the side's outward normal.
export function tipPoint(r: Pick<Route, 'tx' | 'ty' | 'tp'>): { x: number; y: number } {
  return {
    x: r.tx + (r.tp === 'left' ? -TIP_GAP : r.tp === 'right' ? TIP_GAP : 0),
    y: r.ty + (r.tp === 'top' ? -TIP_GAP : r.tp === 'bottom' ? TIP_GAP : 0),
  };
}
