import type { Issue, Module, Sprint } from './types';
import { moduleExperience } from './metrics';

export interface Heat { open: number; done: number; level: number } // level 0 (cold) .. 1 (hottest module)

/** Tasks of one sprint counted per module; level is relative to the busiest module. */
export function sprintHeat(issues: Issue[], sprintId: number): Map<number, Heat> {
  const by = new Map<number, Heat>();
  for (const i of issues) {
    if (i.type !== 'task' || i.sprintId !== sprintId || i.moduleId == null) continue;
    const h = by.get(i.moduleId) ?? { open: 0, done: 0, level: 0 };
    if (i.state !== 'closed') h.open++; else h.done++;
    by.set(i.moduleId, h);
  }
  const max = Math.max(0, ...[...by.values()].map((h) => h.open));
  by.forEach((h) => { h.level = max ? h.open / max : 0; });
  return by;
}

// Blue (cold) through yellow to red (hot).
export const heatColor = (level: number) => `hsl(${Math.round(210 - 210 * level)} 75% ${level > 0.4 ? 62 : 70}%)`;

export interface OwnerLoad { experience: number; open: number; done: number; color: string | null }

/** Where one person stands: modules they have closed tasks in, and their tasks in running or planned sprints per module. */
export function ownerMap(issues: Issue[], modules: Module[], sprints: Sprint[], ownerId: number, color: string | null): Map<number, OwnerLoad> {
  const live = new Set(sprints.filter((s) => s.state !== 'closed').map((s) => s.id));
  const exp = moduleExperience(issues);
  const by = new Map<number, OwnerLoad>(modules.map((m) => [m.id, { experience: exp.get(m.id)?.get(ownerId) ?? 0, open: 0, done: 0, color }]));
  for (const i of issues) {
    if (i.type !== 'task' || i.ownerId !== ownerId || i.moduleId == null || i.sprintId == null || !live.has(i.sprintId)) continue;
    const l = by.get(i.moduleId);
    if (l) { if (i.state !== 'closed') l.open++; else l.done++; }
  }
  return by;
}
