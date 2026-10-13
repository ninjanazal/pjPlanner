// Pure geometry for group containers: nested bounding boxes around member cards, drag-drop membership and group moves.
import type { Group, Module } from './types';

export const GROUP_PAD = 28;
export const GROUP_HEADER = 52;
export interface Rect { x: number; y: number; w: number; h: number }
export type CardRect = Rect & { id: number };
type Pos = { x: number; y: number };

// Group ids from the outermost ancestor down to `id`; stops on unknown ids and cycles.
export function groupChain(groups: Group[], id: number | null): number[] {
  const by = new Map(groups.map((g) => [g.id, g]));
  const chain: number[] = [];
  for (let cur = id; cur != null && by.has(cur) && !chain.includes(cur); cur = by.get(cur)!.parentId ?? null) chain.unshift(cur);
  return chain;
}

// Ids of `id` and every group nested below it.
export function subtreeIds(groups: Group[], id: number): Set<number> {
  return new Set(groups.filter((g) => groupChain(groups, g.id).includes(id)).map((g) => g.id));
}

// Box per group wrapping its direct members' cards and its child groups' boxes; groups with
// nothing in their subtree get no box. `skip` leaves one card out (used while judging a drop).
export function groupBoxes(modules: Module[], groups: Group[], cards: Map<number, Rect>, skip?: number): Map<number, Rect> {
  const out = new Map<number, Rect>();
  const known = new Set(groups.map((g) => g.id));
  const build = (gid: number, seen: Set<number>): Rect | null => {
    const parts: Rect[] = [];
    modules.forEach((m) => { const r = cards.get(m.id); if (m.groupId === gid && m.id !== skip && r) parts.push(r); });
    groups.forEach((g) => {
      if (g.parentId !== gid || seen.has(g.id)) return;
      const c = build(g.id, new Set(seen).add(g.id));
      if (c) parts.push(c);
    });
    if (!parts.length) return null;
    const x1 = Math.min(...parts.map((p) => p.x)); const y1 = Math.min(...parts.map((p) => p.y));
    const x2 = Math.max(...parts.map((p) => p.x + p.w)); const y2 = Math.max(...parts.map((p) => p.y + p.h));
    const box = { x: x1 - GROUP_PAD, y: y1 - GROUP_PAD - GROUP_HEADER, w: x2 - x1 + 2 * GROUP_PAD, h: y2 - y1 + 2 * GROUP_PAD + GROUP_HEADER };
    out.set(gid, box);
    return box;
  };
  groups.forEach((g) => { if (known.has(g.id) && !out.has(g.id)) build(g.id, new Set([g.id])); });
  return out;
}

// Innermost group whose box (computed without the dragged card) contains the card's centre;
// dropping over no box leaves the card's current group unchanged.
export function dropGroup(modules: Module[], groups: Group[], cards: Map<number, Rect>, id: number): number | null {
  const current = modules.find((m) => m.id === id)?.groupId ?? null;
  const r = cards.get(id);
  if (!r) return current;
  const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
  let best: number | null = current; let bestDepth = 0;
  groupBoxes(modules, groups, cards, id).forEach((b, gid) => {
    if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) return;
    const d = groupChain(groups, gid).length;
    if (d > bestDepth) { best = gid; bestDepth = d; }
  });
  return best;
}

// New card positions after moving group `gid` by (dx, dy): every card in its subtree shifts.
export function translateGroup(modules: Module[], groups: Group[], cards: Map<number, Pos>, gid: number, dx: number, dy: number): Map<number, Pos> {
  const ids = subtreeIds(groups, gid);
  const out = new Map<number, Pos>();
  modules.forEach((m) => {
    const p = cards.get(m.id);
    if (m.groupId != null && ids.has(m.groupId) && p) out.set(m.id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
  });
  return out;
}

// "A / B / C" path from the outermost ancestor to the group, optionally prefixed with its icon.
export function groupLabel(groups: Group[], id: number): string {
  const by = new Map(groups.map((g) => [g.id, g]));
  return groupChain(groups, id).map((i) => by.get(i)!.name).join(' / ');
}
