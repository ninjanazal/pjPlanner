import dagre from 'dagre';
import type { Graph, Module } from './types';
import { GROUP_HEADER, GROUP_PAD, groupChain } from './groupBoxes';
import { HUB_MIN_DEPENDANTS } from './linkFocus';

export const CARD_MIN_W = 270;
export const CARD_MAX_W = 420;
const NAME_CHAR_W = 10.2; // 16px bold monospace advance
const CARD_CHROME_W = 48; // horizontal padding + border + slack

// Cards come in three sizes by how connected they are: loosely linked ones stay small, busy ones stand out.
export type CardTier = 'sm' | 'md' | 'lg';
export const cardTier = (links: number): CardTier => (links >= 8 ? 'lg' : links >= 3 ? 'md' : 'sm');
const TIER_SCALE: Record<CardTier, number> = { sm: 0.85, md: 1, lg: 1.2 };
export function cardWidth(name: string, icon?: string | null, tier: CardTier = 'md'): number {
  const chars = [...name].length + (icon ? [...icon].length + 1 : 0);
  const w = Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(chars * NAME_CHAR_W + CARD_CHROME_W)));
  return Math.round(w * TIER_SCALE[tier]);
}
// The collapsed card: name, owners and one summary line for the API items (the full list opens when selected).
const SUMMARY_H = 28;
export function cardCompactHeight(apiCount: number, tier: CardTier = 'md'): number {
  return Math.round((CARD_BASE_H + (apiCount ? SUMMARY_H : 0)) * (tier === 'lg' ? 1.15 : tier === 'sm' ? 0.92 : 1));
}
// Width of a selected card, wide enough to read signatures.
export const CARD_OPEN_W = 380;
export const CARD_BASE_H = 72; // name + owners lines with padding/border
export const CARD_API_MAX = 5;
const API_ROW_H = 24;
const API_SECTION_H = 12;
export function apiRowCount(apiCount: number): number {
  return Math.min(apiCount, CARD_API_MAX) + (apiCount > CARD_API_MAX ? 1 : 0);
}
export function cardHeight(apiCount: number): number {
  const rows = apiRowCount(apiCount);
  return CARD_BASE_H + (rows ? API_SECTION_H + rows * API_ROW_H : 0);
}

type Pos = { x: number; y: number };

const PACK_GAP = 180;
type Piece = { w: number; h: number; pos: Map<string, Pos> };
const shifted = (b: Piece, dx: number, dy: number) => [...b.pos].map(([k, p]): [string, Pos] => [k, { x: p.x + dx, y: p.y + dy }]);

// Rows of pieces, wrapping near a landscape aspect (or at maxW) so a wide forest does not become one long strip.
function shelfPack(pieces: Piece[], gap: number, maxW?: number): Piece {
  if (!pieces.length) return { w: 0, h: 0, pos: new Map() };
  const area = pieces.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const limit = maxW ?? Math.max(...pieces.map((b) => b.w), Math.sqrt(area * 1.8));
  const pos = new Map<string, Pos>();
  let x = 0, y = 0, rowH = 0, w = 0;
  for (const b of pieces) {
    if (x > 0 && x + b.w > limit) { x = 0; y += rowH + gap; rowH = 0; }
    shifted(b, x, y).forEach(([k, p]) => pos.set(k, p));
    x += b.w + gap; rowH = Math.max(rowH, b.h); w = Math.max(w, x - gap);
  }
  return { w, h: y + rowH, pos };
}

function stack(pieces: Piece[], gap: number): Piece {
  const pos = new Map<string, Pos>();
  let y = 0, w = 0;
  pieces.filter((b) => b.pos.size).forEach((b) => { shifted(b, 0, y).forEach(([k, p]) => pos.set(k, p)); y += b.h + gap; w = Math.max(w, b.w); });
  return { w, h: Math.max(0, y - gap), pos };
}

// `right` to the right of `left`, centred vertically against it.
function beside(left: Piece, right: Piece, gap: number): Piece {
  const h = Math.max(left.h, right.h);
  const pos = new Map<string, Pos>([...shifted(left, 0, (h - left.h) / 2), ...shifted(right, left.w + gap, (h - right.h) / 2)]);
  return { w: left.w + gap + right.w, h, pos };
}
const edgesOf = (graph: Graph) => graph.relations.filter((r) => r.sourceId !== r.targetId);
const sizeOf = (m: Module, links: number) => { const t = cardTier(links); return { width: cardWidth(m.name, m.icon, t), height: cardCompactHeight(m.apiItems.length, t) }; };

const CLEAR = 10; // an arrow passing closer than this to a card counts as touching it

// Does the straight link between the centres of two cards cross the box `r`?
function crosses(a: { x: number; y: number }, b: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
  let t0 = 0; let t1 = 1;
  for (const [p, d, lo, hi] of [[a.x, b.x - a.x, r.x - CLEAR, r.x + r.w + CLEAR], [a.y, b.y - a.y, r.y - CLEAR, r.y + r.h + CLEAR]]) {
    if (d === 0) { if (p < lo || p > hi) return false; continue; }
    const u = (lo - p) / d; const v = (hi - p) / d;
    t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
    if (t0 > t1) return false;
  }
  return true;
}

// Dagre ignores that arrows are drawn as straight lines between cards, so a link spanning several ranks can run
// through cards in between. Reorder the cards within each rank (keeping the slots) to cut those crossings, then
// the total link slope.
function untangle(pos: Map<string, Pos>, size: Map<string, { width: number; height: number }>, links: [string, string][]) {
  const keys = [...pos.keys()];
  const ranks = new Map<number, string[]>();
  keys.forEach((k) => { const x = Math.round(pos.get(k)!.x + size.get(k)!.width / 2); ranks.set(x, [...(ranks.get(x) ?? []), k]); });
  const centre = (k: string) => ({ x: pos.get(k)!.x + size.get(k)!.width / 2, y: pos.get(k)!.y + size.get(k)!.height / 2 });
  const cost = () => {
    let c = 0;
    const rects = keys.map((k) => ({ k, x: pos.get(k)!.x, y: pos.get(k)!.y, w: size.get(k)!.width, h: size.get(k)!.height }));
    links.forEach(([a, b]) => {
      const pa = centre(a); const pb = centre(b);
      c += Math.abs(pa.y - pb.y) / 100;
      rects.forEach((r) => { if (r.k !== a && r.k !== b && crosses(pa, pb, r)) c += 100; });
    });
    return c;
  };
  const reorder = (col: string[], order: string[]) => {
    const slots = col.map((k) => pos.get(k)!.y).sort((a, b) => a - b);
    const gaps = slots.map((y, i) => (i === 0 ? 0 : y - slots[i - 1] - size.get(sortedBy[i - 1])!.height));
    let y = slots[0];
    order.forEach((k, i) => { y += i === 0 ? 0 : gaps[i]; pos.get(k)!.y = y; y += size.get(k)!.height; });
  };
  let sortedBy: string[] = [];
  let best = cost();
  for (let pass = 0; pass < 6 && best > 0; pass++) {
    let improved = false;
    ranks.forEach((col) => {
      if (col.length < 2) return;
      for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) {
        const cur = [...col].sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);
        sortedBy = cur;
        const saved = new Map(col.map((k) => [k, pos.get(k)!.y]));
        const order = [...cur];
        const [ia, ib] = [order.indexOf(col[i]), order.indexOf(col[j])];
        [order[ia], order[ib]] = [order[ib], order[ia]];
        reorder(col, order);
        const c = cost();
        if (c < best - 1e-6) { best = c; improved = true; } else saved.forEach((y, k) => { pos.get(k)!.y = y; });
      }
    });
    if (!improved) break;
  }
}

// Left-to-right layered layout; returns top-left positions keyed by module id.
// Each group is laid out on its own (leaves and child-group blocks per level) and placed as one block.
export function autoLayout(graph: Graph): Map<number, Pos> {
  const groups = graph.groups ?? [];
  const chains = new Map(graph.modules.map((m) => [m.id, groupChain(groups, m.groupId)]));
  const by = new Map(graph.modules.map((m) => [m.id, m]));
  type Block = { w: number; h: number; pos: Map<string, Pos> };
  const blocks = new Map<number | null, Block>();

  // Key of the item that holds module `m` directly inside `scope` (a card, or the child group on its chain).
  const itemKey = (m: Module, scope: number | null) => {
    const c = chains.get(m.id)!;
    const next = scope == null ? c[0] : c[c.indexOf(scope) + 1];
    return next != null ? `g${next}` : String(m.id);
  };
  const inScope = (m: Module, scope: number | null) => scope == null || chains.get(m.id)!.includes(scope);

  const degree = new Map<number, number>();
  edgesOf(graph).forEach((r) => { degree.set(r.sourceId, (degree.get(r.sourceId) ?? 0) + 1); degree.set(r.targetId, (degree.get(r.targetId) ?? 0) + 1); });

  const layout = (scope: number | null): Block => {
    const mods = graph.modules.filter((m) => inScope(m, scope));
    const size = new Map<string, { width: number; height: number }>();
    mods.forEach((m) => {
      const k = itemKey(m, scope);
      if (size.has(k)) return;
      if (k.startsWith('g')) {
        const b = layout(Number(k.slice(1)));
        blocks.set(Number(k.slice(1)), b);
        size.set(k, { width: b.w + 2 * GROUP_PAD, height: b.h + 2 * GROUP_PAD + GROUP_HEADER });
      } else size.set(k, sizeOf(m, degree.get(m.id) ?? 0));
    });
    const seen = new Set<string>();
    const links: [string, string][] = [];
    edgesOf(graph).forEach((r) => {
      const s = by.get(r.sourceId); const t = by.get(r.targetId);
      if (!s || !t || !inScope(s, scope) || !inScope(t, scope)) return;
      const a = itemKey(s, scope); const b = itemKey(t, scope);
      if (a !== b && !seen.has(`${a}>${b}`)) { seen.add(`${a}>${b}`); links.push([a, b]); }
    });

    // Shared foundations (many dependants) would drag every rank towards them and cross the whole diagram:
    // keep them and their links out of the layering and park them in their own column at the right.
    const hubs = new Set<string>();
    if (scope == null) {
      const n = new Map<string, number>();
      links.forEach(([, b]) => { if (!b.startsWith('g')) n.set(b, (n.get(b) ?? 0) + 1); });
      n.forEach((c, k) => { if (c >= HUB_MIN_DEPENDANTS) hubs.add(k); });
    }
    const live = links.filter(([a, b]) => !hubs.has(a) && !hubs.has(b));

    // Connected pieces are laid out on their own so unrelated clusters do not interleave.
    const parent = new Map<string, string>([...size.keys()].map((k) => [k, k]));
    const root = (k: string): string => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k)!)!); k = parent.get(k)!; } return k; };
    live.forEach(([a, b]) => parent.set(root(a), root(b)));
    const comps = new Map<string, string[]>();
    [...size.keys()].filter((k) => !hubs.has(k)).forEach((k) => comps.set(root(k), [...(comps.get(root(k)) ?? []), k]));

    const pieces: Block[] = [];
    const loose: Block[] = [];
    comps.forEach((keys) => {
      if (keys.length === 1) {
        const d = size.get(keys[0])!;
        loose.push({ w: d.width, h: d.height, pos: new Map([[keys[0], { x: 0, y: 0 }]]) });
        return;
      }
      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: 'LR', nodesep: scope == null ? 150 : 100, ranksep: scope == null ? 320 : 220, marginx: 0, marginy: 0, acyclicer: 'greedy' });
      g.setDefaultEdgeLabel(() => ({}));
      keys.forEach((k) => g.setNode(k, size.get(k)!));
      const inComp = new Set(keys);
      live.filter(([a]) => inComp.has(a)).forEach(([a, b]) => g.setEdge(a, b));
      dagre.layout(g);
      const pos = new Map<string, Pos>();
      g.nodes().forEach((k) => { const n = g.node(k); pos.set(k, { x: n.x - n.width / 2, y: n.y - n.height / 2 }); });
      untangle(pos, size, live.filter(([a, b]) => inComp.has(a) && inComp.has(b)));
      pieces.push({ w: g.graph().width ?? 0, h: g.graph().height ?? 0, pos });
    });

    const margin = scope == null ? 20 : 0;
    // Biggest clusters first, then the unconnected cards as a compact grid below them.
    pieces.sort((a, b) => b.w * b.h - a.w * a.h);
    const main = shelfPack(pieces, PACK_GAP);
    const grid = shelfPack(loose.sort((a, b) => b.h - a.h), PACK_GAP / 2, Math.max(main.w, 2 * CARD_MAX_W + PACK_GAP));
    const body = stack([main, grid], PACK_GAP);
    const hubBlocks: Block[] = [...hubs].map((k) => { const d = size.get(k)!; return { w: d.width, h: d.height, pos: new Map([[k, { x: 0, y: 0 }]]) }; });
    const column = stack(hubBlocks, PACK_GAP / 2);
    const all = column.pos.size ? beside(body, column, 2 * PACK_GAP) : body;
    const pos = new Map<string, Pos>();
    all.pos.forEach((p, k) => pos.set(k, { x: p.x + margin, y: p.y + margin }));
    return { w: all.w + 2 * margin, h: all.h + 2 * margin, pos };
  };

  const out = new Map<number, Pos>();
  const place = (b: Block, ox: number, oy: number) => b.pos.forEach((p, k) => {
    if (k.startsWith('g')) place(blocks.get(Number(k.slice(1)))!, ox + p.x + GROUP_PAD, oy + p.y + GROUP_PAD + GROUP_HEADER);
    else out.set(Number(k), { x: Math.round(ox + p.x), y: Math.round(oy + p.y) });
  });
  place(layout(null), 0, 0);
  return out;
}
