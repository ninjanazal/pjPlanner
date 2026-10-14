import { describe, expect, it } from 'vitest';
import { edgeView, hubCounts, neighbourhood, HUB_MIN_DEPENDANTS } from '../linkFocus';
import type { Relation } from '../types';

const rel = (id: number, sourceId: number, targetId: number): Relation => ({ id, sourceId, targetId, label: null, color: null });

describe('linkFocus', () => {
  const hubRels = Array.from({ length: HUB_MIN_DEPENDANTS }, (_, i) => rel(i + 1, i + 10, 1));
  const hubs = hubCounts(hubRels);

  it('detects a module many others depend on', () => {
    expect([...hubs]).toEqual([[1, HUB_MIN_DEPENDANTS]]);
    expect(hubCounts(hubRels.slice(1)).size).toBe(0);
  });

  it('neighbourhood is the module plus direct links in both directions', () => {
    expect(neighbourhood([rel(1, 1, 2), rel(2, 3, 1), rel(3, 4, 5)], 1)).toEqual(new Set([1, 2, 3]));
  });

  it('keeps everything lit with no focus, dims others with a focus', () => {
    const o = { mode: 'all' as const, hideHubs: false, hubs, focusId: null };
    expect(edgeView(rel(1, 2, 3), o)).toEqual({ visible: true, dim: false });
    expect(edgeView(rel(1, 2, 3), { ...o, focusId: 9 })).toEqual({ visible: true, dim: true });
    expect(edgeView(rel(1, 9, 3), { ...o, focusId: 9 })).toEqual({ visible: true, dim: false });
  });

  it('focus mode hides unrelated edges', () => {
    const o = { mode: 'focus' as const, hideHubs: false, hubs, focusId: 9 };
    expect(edgeView(rel(1, 2, 3), o).visible).toBe(false);
    expect(edgeView(rel(1, 9, 3), o).visible).toBe(true);
  });

  it('hides edges into hubs unless they touch the focused module', () => {
    const o = { mode: 'all' as const, hideHubs: true, hubs, focusId: null };
    expect(edgeView(rel(1, 10, 1), o).visible).toBe(false);
    expect(edgeView(rel(1, 10, 1), { ...o, focusId: 10 }).visible).toBe(true);
    expect(edgeView(rel(1, 10, 2), o).visible).toBe(true);
  });
});

import { dependencyRoles, edgeRole } from '../linkFocus';

describe('dependency roles', () => {
  const rels = [rel(1, 5, 6), rel(2, 7, 5), rel(3, 8, 9)];
  it('splits what the module depends on from what depends on it', () => {
    expect(dependencyRoles(rels, 5)).toEqual({ dependsOn: new Set([6]), dependants: new Set([7]) });
  });
  it('colours edges by direction relative to the selection', () => {
    expect(edgeRole(rels[0], 5)).toBe('out');
    expect(edgeRole(rels[1], 5)).toBe('in');
    expect(edgeRole(rels[2], 5)).toBeNull();
    expect(edgeRole(rels[0], null)).toBeNull();
  });
});
