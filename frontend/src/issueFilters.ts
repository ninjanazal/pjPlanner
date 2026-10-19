import { useState } from 'react';
import type { Issue, IssueState, IssueType } from './types';
import { epicOf } from './sprintGroups';

// `'none'` matches issues without the value; null means "any".
export interface IssueFilter {
  text: string;
  ownerId: number | 'none' | null;
  moduleId: number | 'none' | null;
  state: IssueState | null;
  type: IssueType | null;
  epicId: number | 'none' | null;
  sprintId: number | 'none' | null; // 'none' = backlog
}

export const NO_FILTER: IssueFilter = { text: '', ownerId: null, moduleId: null, state: null, type: null, epicId: null, sprintId: null };

export const isFiltering = (f: IssueFilter) => JSON.stringify(f) !== JSON.stringify(NO_FILTER);

export function matchesFilter(i: Issue, f: IssueFilter, all: Issue[] = []): boolean {
  const q = f.text.trim().toLowerCase();
  if (q && !`${i.title} #${i.id} ${i.jiraKey ?? ''}`.toLowerCase().includes(q)) return false;
  if (f.ownerId != null && (f.ownerId === 'none' ? i.ownerId != null : i.ownerId !== f.ownerId)) return false;
  if (f.moduleId != null && (f.moduleId === 'none' ? i.moduleId != null : i.moduleId !== f.moduleId)) return false;
  if (f.state && i.state !== f.state) return false;
  if (f.type && i.type !== f.type) return false;
  if (f.sprintId != null && (f.sprintId === 'none' ? i.sprintId != null : i.sprintId !== f.sprintId)) return false;
  if (f.epicId != null) {
    const e = i.type === 'epic' ? i : epicOf(i, all);
    if (f.epicId === 'none' ? e != null : e?.id !== f.epicId) return false;
  }
  return true;
}

// State that survives navigation within the tab; storage may be unavailable, so it only ever degrades to plain state.
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = sessionStorage.getItem(key);
      if (!s) return initial;
      const saved = JSON.parse(s);
      // Objects merge over the defaults so a newly added field is never missing; arrays and scalars must keep their type.
      const plain = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
      if (plain(initial)) return plain(saved) ? { ...initial, ...saved } : initial;
      return Array.isArray(initial) === Array.isArray(saved) ? saved : initial;
    } catch { return initial; }
  });
  const set = (n: T | ((p: T) => T)) => setV((p) => {
    const next = typeof n === 'function' ? (n as (p: T) => T)(p) : n;
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  return [v, set];
}
