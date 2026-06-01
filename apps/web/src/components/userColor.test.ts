import { describe, it, expect } from 'vitest';
import { userColorTokens } from './userColor';

describe('userColorTokens', () => {
  it('returns the same tokens for the same identity (deterministic)', () => {
    const a = userColorTokens('user-123');
    const b = userColorTokens('user-123');
    expect(a).toEqual(b);
  });

  it('returns different caret colors for different identities (most of the time)', () => {
    // The hue space is 360 values and FNV-1a is decent at spreading short
    // inputs, so this is overwhelmingly likely to hold for short test ids.
    const a = userColorTokens('user-A');
    const b = userColorTokens('user-B');
    expect(a.caret).not.toBe(b.caret);
  });

  it('selection color is the same hue as caret but translucent', () => {
    const { caret, selection } = userColorTokens('xyz');
    const caretHue = /hsl\((\d+),/.exec(caret)?.[1];
    const selectionHue = /hsla\((\d+),/.exec(selection)?.[1];
    expect(caretHue).toBeTruthy();
    expect(selectionHue).toBe(caretHue);
    expect(selection).toContain('0.25');
  });

  it('produces an HSL string with hue in [0, 360)', () => {
    for (const id of ['', 'a', '😀-user', 'pablo@example.com', '00000000-0000-0000-0000-000000000000']) {
      const { caret } = userColorTokens(id);
      const hue = Number(/hsl\((\d+),/.exec(caret)?.[1]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
