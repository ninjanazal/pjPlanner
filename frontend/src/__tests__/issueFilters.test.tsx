import { renderHook, act } from '@testing-library/react';
import { NO_FILTER, matchesFilter, usePersisted } from '../issueFilters';
import type { Issue } from '../types';

const t = (o: Partial<Issue> = {}): Issue => ({ id: 1, type: 'task', title: 'T', description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...o });

describe('usePersisted', () => {
  beforeEach(() => sessionStorage.clear());
  it('keeps arrays as arrays after a reload (they once came back as objects)', () => {
    const a = renderHook(() => usePersisted<number[]>('k', []));
    act(() => a.result.current[1]([3, 4]));
    const b = renderHook(() => usePersisted<number[]>('k', []));
    expect(Array.isArray(b.result.current[0])).toBe(true);
    expect(b.result.current[0].includes(3)).toBe(true);
  });
  it('merges saved objects over the defaults', () => {
    sessionStorage.setItem('f', JSON.stringify({ text: 'x' }));
    expect(renderHook(() => usePersisted('f', NO_FILTER)).result.current[0]).toEqual({ ...NO_FILTER, text: 'x' });
  });
  it('ignores a saved value of the wrong shape', () => {
    sessionStorage.setItem('k', JSON.stringify({ 0: 1 }));
    expect(renderHook(() => usePersisted<number[]>('k', [])).result.current[0]).toEqual([]);
  });
});

describe('sprint filter', () => {
  it('matches a sprint or the backlog', () => {
    expect(matchesFilter(t({ sprintId: 2 }), { ...NO_FILTER, sprintId: 2 })).toBe(true);
    expect(matchesFilter(t({ sprintId: 3 }), { ...NO_FILTER, sprintId: 2 })).toBe(false);
    expect(matchesFilter(t(), { ...NO_FILTER, sprintId: 'none' })).toBe(true);
    expect(matchesFilter(t({ sprintId: 2 }), { ...NO_FILTER, sprintId: 'none' })).toBe(false);
  });
});
