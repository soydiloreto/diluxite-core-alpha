import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from './rrf';

describe('reciprocalRankFusion', () => {
  it('lista vacía => []', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it('una sola lista preserva el orden', () => {
    const r = reciprocalRankFusion([['a', 'b', 'c']]);
    expect(r.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('un item presente en ambas listas rankea más alto', () => {
    // 'b' aparece en las dos listas; debería ganarle a 'a' y 'c'
    const r = reciprocalRankFusion([
      ['a', 'b'],
      ['c', 'b'],
    ]);
    expect(r[0].id).toBe('b');
  });

  it('respeta el orden por score y devuelve scores descendentes', () => {
    const r = reciprocalRankFusion([
      ['x', 'y', 'z'],
      ['y', 'x'],
    ]);
    expect(r.map((x) => x.id)).toEqual(['x', 'y', 'z']);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
    }
  });
});
