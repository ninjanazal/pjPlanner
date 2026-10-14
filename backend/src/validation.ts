import { bad, notFound } from './errors.js';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export type Body = Record<string, unknown>;
export const obj = (b: unknown): Body => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be a JSON object');
  return b as Body;
};
export const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} must be a non-empty string`);
  return v.trim();
};
export const colorField = (b: Body, field: string): string | null | undefined => {
  const v = b[field];
  if (v === undefined || v === null) return v;
  if (typeof v === 'string' && COLOR_RE.test(v)) return v.toLowerCase();
  throw bad(`${field} must be a #rrggbb hex string or null`);
};
export const iconField = (b: Body): string | null | undefined => {
  if (b.icon === undefined || b.icon === null) return b.icon;
  if (typeof b.icon !== 'string') throw bad('icon must be a string or null');
  const t = b.icon.trim();
  const len = [...t].length;
  if (len < 1 || len > 8) throw bad('icon must be 1-8 characters');
  return t;
};
export const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw notFound('resource');
  return n;
};
export const labelOf = (v: unknown) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad('label must be a string or null');
  return v;
};
