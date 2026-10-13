export type HighlightIds = ReadonlySet<number> | readonly number[] | null | undefined;

// An empty selection (issue touching 0 modules) dims nothing, same as no selection.
export function normalizeHighlight(ids: HighlightIds): Set<number> | null {
  if (!ids) return null;
  const s = new Set(ids);
  return s.size > 0 ? s : null;
}

export const HL_ON = 'hl-on';
export const HL_DIM = 'hl-dim';

export function cardHighlightClass(ids: Set<number> | null, moduleId: number): string {
  if (!ids) return '';
  return ids.has(moduleId) ? HL_ON : HL_DIM;
}

// An edge stays lit only when both ends are touched.
export function edgeHighlightClass(ids: Set<number> | null, sourceId: number, targetId: number): string {
  if (!ids) return '';
  return ids.has(sourceId) && ids.has(targetId) ? '' : HL_DIM;
}

export const groupHighlightClass = (ids: Set<number> | null): string => (ids ? HL_DIM : '');
