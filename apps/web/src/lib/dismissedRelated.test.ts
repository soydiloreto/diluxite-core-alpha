import { describe, it, expect, beforeEach } from 'vitest';
import { getDismissed, dismissRelated } from './dismissedRelated';

describe('dismissedRelated', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty and remembers dismissed targets for a source note', () => {
    expect(getDismissed('src').size).toBe(0);
    dismissRelated('src', 't1');
    dismissRelated('src', 't2');
    expect([...getDismissed('src')].sort()).toEqual(['t1', 't2']);
  });

  it('is scoped per source note', () => {
    dismissRelated('a', 'x');
    expect(getDismissed('a').has('x')).toBe(true);
    expect(getDismissed('b').has('x')).toBe(false);
  });

  it('dedupes repeated dismissals', () => {
    dismissRelated('s', 'x');
    dismissRelated('s', 'x');
    expect(getDismissed('s').size).toBe(1);
  });

  it('persists through localStorage (survives a fresh read)', () => {
    dismissRelated('s', 'keep');
    // A new getDismissed reads from storage, not memory.
    expect(getDismissed('s').has('keep')).toBe(true);
  });

  it('tolerates corrupt storage without throwing', () => {
    localStorage.setItem('diluxite.dismissedRelated', 'not json{');
    expect(getDismissed('s').size).toBe(0);
  });
});
