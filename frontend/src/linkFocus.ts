import type { Relation } from './types';

// A module that this many others depend on is a shared foundation: drawing every edge into it only adds noise.
export const HUB_MIN_DEPENDANTS = 8;

export type LinkMode = 'all' | 'focus';

// Dependant count per module, only for those that reach HUB_MIN_DEPENDANTS.
export function hubCounts(relations: Relation[]): Map<number, number> {
  const n = new Map<number, number>();
  for (const r of relations) n.set(r.targetId, (n.get(r.targetId) ?? 0) + 1);
  return new Map([...n].filter(([, c]) => c >= HUB_MIN_DEPENDANTS));
}

export const DEPENDS_ON_COLOR = '#0ea5e9'; // what the selected module depends on
export const DEPENDANT_COLOR = '#f59e0b'; // what depends on the selected module

// A relation source -> target means source depends on target.
export function dependencyRoles(relations: Relation[], moduleId: number): { dependsOn: Set<number>; dependants: Set<number> } {
  const dependsOn = new Set<number>(), dependants = new Set<number>();
  for (const r of relations) {
    if (r.sourceId === moduleId) dependsOn.add(r.targetId);
    else if (r.targetId === moduleId) dependants.add(r.sourceId);
  }
  return { dependsOn, dependants };
}

export type EdgeRole = 'out' | 'in' | null; // out: selected depends on target; in: source depends on selected
export function edgeRole(r: Relation, focusId: number | null): EdgeRole {
  if (focusId === null) return null;
  if (r.sourceId === focusId) return 'out';
  if (r.targetId === focusId) return 'in';
  return null;
}

// The selected module plus every module directly linked to it, in either direction.
export function neighbourhood(relations: Relation[], moduleId: number): Set<number> {
  const s = new Set<number>([moduleId]);
  for (const r of relations) {
    if (r.sourceId === moduleId) s.add(r.targetId);
    else if (r.targetId === moduleId) s.add(r.sourceId);
  }
  return s;
}

export interface EdgeView { visible: boolean; dim: boolean }

// `focusId` is the selected module (null when none). Edges touching it always stay visible and lit.
export function edgeView(r: Relation, opts: { mode: LinkMode; hideHubs: boolean; hubs: Map<number, number>; focusId: number | null }): EdgeView {
  const touchesFocus = opts.focusId !== null && (r.sourceId === opts.focusId || r.targetId === opts.focusId);
  if (touchesFocus) return { visible: true, dim: false };
  if (opts.focusId !== null && opts.mode === 'focus') return { visible: false, dim: true };
  if (opts.hideHubs && opts.hubs.has(r.targetId)) return { visible: false, dim: false };
  return { visible: true, dim: opts.focusId !== null };
}
