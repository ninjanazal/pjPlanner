import { autoAssign } from '../autoAssign';
import type { Module, Owner } from '../types';

const mod = (id: number, ownerIds: number[] = []): Module => ({
  id, name: `m${id}`, description: '', ownerIds, color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const owners: Owner[] = [1, 2, 3].map((id) => ({ id, name: `o${id}`, color: null, icon: null }));

describe('autoAssign', () => {
  it('gives every module two distinct owners, balanced', () => {
    const mods = [1, 2, 3, 4, 5, 6].map((i) => mod(i));
    const res = autoAssign(mods, owners);
    const load = new Map<number, number>();
    mods.forEach((m) => { const ids = res.get(m.id)!; expect(new Set(ids).size).toBe(2); ids.forEach((o) => load.set(o, (load.get(o) ?? 0) + 1)); });
    expect([...load.values()]).toEqual([4, 4, 4]);
  });
  it('keeps existing owners and only fills the gap', () => {
    const res = autoAssign([mod(1, [3]), mod(2, [1, 2])], owners);
    expect(res.get(1)![0]).toBe(3);
    expect(res.get(1)).toHaveLength(2);
    expect(res.has(2)).toBe(false);
  });
  it('assigns what it can with fewer owners, nothing with none', () => {
    expect(autoAssign([mod(1)], [owners[0]]).get(1)).toEqual([1]);
    expect(autoAssign([mod(1)], []).size).toBe(0);
  });
});
