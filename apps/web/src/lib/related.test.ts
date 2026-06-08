import { describe, it, expect } from 'vitest';
import { filterRelated, relevanceFromDistance, RELATED_MIN_RELEVANCE } from './related';

const item = (id: string, distance: number) => ({ id, title: id, distance });

describe('relevanceFromDistance', () => {
  it('maps cosine distance to 0..1 (closer = higher)', () => {
    expect(relevanceFromDistance(0)).toBe(1);
    expect(relevanceFromDistance(2)).toBe(0);
    expect(relevanceFromDistance(1)).toBe(0.5);
  });
});

describe('filterRelated', () => {
  it('drops suggestions below the relevance threshold and counts them as weak', () => {
    // distance 0.5 → 0.75 rel (keep); 1.0 → 0.5 rel (weak, below 0.62).
    const { shown, weak } = filterRelated([item('a', 0.5), item('b', 1.0)]);
    expect(shown.map((s) => s.id)).toEqual(['a']);
    expect(weak).toBe(1);
  });

  it('shows every above-threshold match (no cap → badge matches the list)', () => {
    const items = Array.from({ length: 9 }, (_, i) => item(`n${i}`, 0.2));
    const { shown, weak } = filterRelated(items);
    expect(shown).toHaveLength(9);
    expect(weak).toBe(0);
  });

  it('excludes dismissed targets (not counted as weak)', () => {
    const { shown, weak } = filterRelated([item('a', 0.2), item('b', 0.2)], {
      dismissed: new Set(['a']),
    });
    expect(shown.map((s) => s.id)).toEqual(['b']);
    expect(weak).toBe(0);
  });

  it('orders best-first by distance', () => {
    const { shown } = filterRelated([item('far', 0.4), item('near', 0.1)]);
    expect(shown.map((s) => s.id)).toEqual(['near', 'far']);
  });

  it('the default threshold is conservative (precision over recall)', () => {
    expect(RELATED_MIN_RELEVANCE).toBeGreaterThanOrEqual(0.6);
  });
});
