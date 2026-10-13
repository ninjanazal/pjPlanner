import dagre from 'dagre';
import type { Graph, Module } from './types';
import { GROUP_HEADER, GROUP_PAD, groupChain } from './groupBoxes';

export const CARD_MIN_W = 270;
export const CARD_MAX_W = 420;
const NAME_CHAR_W = 10.2; // 16px bold monospace advance
const CARD_CHROME_W = 48; // horizontal padding + border + slack

export function cardWidth(name: string, icon?: string | null): number {
  const chars = [...name].length + (icon ? [...icon].length + 1 : 0);
  return Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(chars * NAME_CHAR_W + CARD_CHROME_W)));
}
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
const edgesOf = (graph: Graph) => graph.relations.filter((r) => r.sourceId !== r.targetId);
const sizeOf = (m: Module) => ({ width: cardWidth(m.name, m.icon), height: cardHeight(m.apiItems.length) });

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

  const layout = (scope: number | null): Block => {
    const mods = graph.modules.filter((m) => inScope(m, scope));
    const g = new dagre.graphlib.Graph();
    const margin = scope == null ? 20 : 0;
    g.setGraph({ rankdir: 'LR', nodesep: scope == null ? 72 : 48, ranksep: scope == null ? 150 : 120, marginx: margin, marginy: margin });
    g.setDefaultEdgeLabel(() => ({}));
    mods.forEach((m) => {
      const k = itemKey(m, scope);
      if (g.hasNode(k)) return;
      if (k.startsWith('g')) {
        const b = layout(Number(k.slice(1)));
        blocks.set(Number(k.slice(1)), b);
        g.setNode(k, { width: b.w + 2 * GROUP_PAD, height: b.h + 2 * GROUP_PAD + GROUP_HEADER });
      } else g.setNode(k, sizeOf(m));
    });
    edgesOf(graph).forEach((r) => {
      const s = by.get(r.sourceId); const t = by.get(r.targetId);
      if (!s || !t || !inScope(s, scope) || !inScope(t, scope)) return;
      const a = itemKey(s, scope); const b = itemKey(t, scope);
      if (a !== b) g.setEdge(a, b);
    });
    dagre.layout(g);
    const pos = new Map<string, Pos>();
    g.nodes().forEach((k) => { const n = g.node(k); pos.set(k, { x: n.x - n.width / 2, y: n.y - n.height / 2 }); });
    return { w: g.graph().width ?? 0, h: g.graph().height ?? 0, pos };
  };

  const out = new Map<number, Pos>();
  const place = (b: Block, ox: number, oy: number) => b.pos.forEach((p, k) => {
    if (k.startsWith('g')) place(blocks.get(Number(k.slice(1)))!, ox + p.x + GROUP_PAD, oy + p.y + GROUP_PAD + GROUP_HEADER);
    else out.set(Number(k), { x: Math.round(ox + p.x), y: Math.round(oy + p.y) });
  });
  place(layout(null), 0, 0);
  return out;
}
