// Pure alignment-guide maths: snap a dragged rect's edges/centres to those of other rects.
import type { Rect } from './groupBoxes';

export const GUIDE_THRESHOLD = 6; // screen px; callers divide by zoom
// A guide line in flow coordinates: vertical at x spanning y1..y2, or horizontal at y spanning x1..x2.
export interface Guide { axis: 'v' | 'h'; pos: number; from: number; to: number }
export interface SnapResult { x: number; y: number; guides: Guide[] }

const lines = (a: number, size: number) => [a, a + size / 2, a + size];

// Smallest offset (within threshold) that lines a moving line up with any other line, or null.
function bestOffset(moving: number[], others: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const m of moving) for (const o of others) {
    const d = o - m;
    if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}

export function snapGuides(moving: Rect, others: Rect[], threshold = GUIDE_THRESHOLD): SnapResult {
  const dx = bestOffset(lines(moving.x, moving.w), others.flatMap((o) => lines(o.x, o.w)), threshold);
  const dy = bestOffset(lines(moving.y, moving.h), others.flatMap((o) => lines(o.y, o.h)), threshold);
  const x = moving.x + (dx ?? 0);
  const y = moving.y + (dy ?? 0);
  const guides: Guide[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  if (dx !== null) {
    lines(x, moving.w).forEach((mx) => others.forEach((o) => {
      if (lines(o.x, o.w).some((ox) => near(ox, mx))) {
        guides.push({ axis: 'v', pos: mx, from: Math.min(y, o.y), to: Math.max(y + moving.h, o.y + o.h) });
      }
    }));
  }
  if (dy !== null) {
    lines(y, moving.h).forEach((my) => others.forEach((o) => {
      if (lines(o.y, o.h).some((oy) => near(oy, my))) {
        guides.push({ axis: 'h', pos: my, from: Math.min(x, o.x), to: Math.max(x + moving.w, o.x + o.w) });
      }
    }));
  }
  return { x, y, guides };
}
