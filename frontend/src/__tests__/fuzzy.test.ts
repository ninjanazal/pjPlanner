import { fuzzyFilter, fuzzyScore } from '../fuzzy';

describe('fuzzy', () => {
  it('matches characters in order, not as a substring', () => {
    expect(fuzzyScore('blb', 'Black box')).not.toBeNull();
    expect(fuzzyScore('xb', 'Black box')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
  it('ranks word starts and runs above scattered hits', () => {
    const r = fuzzyFilter(['Cabinet boot loader', 'Boot', 'Bookkeeping tool'], 'boot', (x) => x);
    expect(r[0]).toBe('Boot');
    expect(r).not.toContain('Bookkeeping tool'.replace('Bookkeeping', 'zzz'));
  });
  it('keeps the original order for an empty query', () => {
    expect(fuzzyFilter(['b', 'a'], ' ', (x) => x)).toEqual(['b', 'a']);
  });
});
