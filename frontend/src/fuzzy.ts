// Subsequence match ("blb" finds "black box"): every query character must appear in order. Higher score = better
// (consecutive runs and word starts count more, earlier matches win). Returns null when it does not match.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const wordStart = at === 0 || /[^a-z0-9]/.test(t[at - 1]);
    run = at === ti && ti > 0 ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(at - ti, 5) * 0.2;
    ti = at + 1;
  }
  return score - t.length * 0.01;
}

// Best matches first; with an empty query the original order is kept.
export function fuzzyFilter<T>(items: T[], query: string, text: (i: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((i) => ({ i, s: fuzzyScore(query, text(i)) }))
    .filter((x): x is { i: T; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}
