import type { Module, Owner } from './types';

export const OWNERS_PER_MODULE = 2;

/** Fills each module up to `per` owners, always picking the owner with the fewest modules so far. Never removes an existing owner. */
export function autoAssign(modules: Module[], owners: Owner[], per = OWNERS_PER_MODULE): Map<number, number[]> {
  const load = new Map(owners.map((o) => [o.id, 0]));
  modules.forEach((m) => m.ownerIds.forEach((id) => load.has(id) && load.set(id, load.get(id)! + 1)));
  const changes = new Map<number, number[]>();
  const todo = modules.filter((m) => m.ownerIds.length < per).sort((a, b) => a.ownerIds.length - b.ownerIds.length || a.id - b.id);
  for (const m of todo) {
    const ids = [...m.ownerIds];
    while (ids.length < per) {
      const pick = owners.filter((o) => !ids.includes(o.id)).sort((a, b) => load.get(a.id)! - load.get(b.id)! || a.id - b.id)[0];
      if (!pick) break;
      ids.push(pick.id);
      load.set(pick.id, load.get(pick.id)! + 1);
    }
    if (ids.length > m.ownerIds.length) changes.set(m.id, ids);
  }
  return changes;
}
