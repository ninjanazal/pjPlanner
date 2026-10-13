import { useSyncExternalStore } from 'react';

export const SAVED_COLORS_KEY = 'pjplanner-saved-colors';
export const MAX_SAVED_COLORS = 24;
const HEX = /^#[0-9a-f]{6}$/;

let cache: { raw: string | null; list: string[] } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try { return localStorage.getItem(SAVED_COLORS_KEY); } catch { return null; }
}

function parse(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const c of v) {
      if (typeof c !== 'string') continue;
      const l = c.toLowerCase();
      if (HEX.test(l) && !out.includes(l)) out.push(l);
    }
    return out.slice(0, MAX_SAVED_COLORS);
  } catch { return []; }
}

// Stable array identity per raw value, as useSyncExternalStore requires.
export function getSavedColors(): string[] {
  const raw = readRaw();
  if (!cache || cache.raw !== raw) cache = { raw, list: parse(raw) };
  return cache.list;
}

function write(list: string[]) {
  try { localStorage.setItem(SAVED_COLORS_KEY, JSON.stringify(list)); } catch { /* unavailable: ignore */ }
  cache = null;
  listeners.forEach((l) => l());
}

export function addSavedColor(color: string) {
  const c = color.toLowerCase();
  if (!HEX.test(c)) return;
  write([c, ...getSavedColors().filter((x) => x !== c)].slice(0, MAX_SAVED_COLORS));
}

export function removeSavedColor(color: string) {
  const c = color.toLowerCase();
  write(getSavedColors().filter((x) => x !== c));
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => { listeners.delete(cb); window.removeEventListener('storage', cb); };
}

export const useSavedColors = () => useSyncExternalStore(subscribe, getSavedColors, getSavedColors);
