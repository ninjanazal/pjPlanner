export interface ApiItem {
  id?: number;
  kind?: string;
  name: string;
  signature?: string;
  description?: string;
}

const same = (a: ApiItem, b: ApiItem) => a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && (a.kind ?? "other") === (b.kind ?? "other");

/** Appends `incoming` to `current`; an item with the same kind and name replaces the old one in place (keeping its id). */
export function mergeApiItems(current: ApiItem[], incoming: ApiItem[]): ApiItem[] {
  const out = current.map((c) => ({ ...c }));
  for (const item of incoming) {
    const at = out.findIndex((c) => same(c, item));
    if (at >= 0) out[at] = { ...out[at], ...item, id: out[at].id };
    else out.push({ ...item });
  }
  return out;
}

/** Drops the items whose id is in `ids` or whose name (case-insensitive) is in `names`. */
export function dropApiItems(current: ApiItem[], ids: number[], names: string[]): ApiItem[] {
  const lower = names.map((n) => n.trim().toLowerCase());
  return current.filter((c) => !(c.id !== undefined && ids.includes(c.id)) && !lower.includes(c.name.trim().toLowerCase()));
}
