import { describe, it, expect } from 'vitest';
import { isEmailShaped, MAX_EMAIL_LENGTH } from './email-shape';

describe('isEmailShaped', () => {
  it('accepts ordinary addresses', () => {
    for (const ok of [
      'a@x.com',
      'pablo.di.loreto@empresa.com.ar',
      'name+tag@sub.domain.co',
      'UPPER@Example.COM',
    ]) {
      expect(isEmailShaped(ok)).toBe(true);
    }
  });

  it('rejects what is not shaped like an address', () => {
    for (const bad of [
      '',
      'sin-arroba.com',
      '@x.com',
      'a@',
      'a@b', // no dot in the domain
      'a b@x.com', // whitespace
      'a@x .com',
      'a@@x.com',
    ]) {
      expect(isEmailShaped(bad)).toBe(false);
    }
  });

  it('rejects anything longer than the RFC 5321 limit', () => {
    const atLimit = `${'a'.repeat(MAX_EMAIL_LENGTH - '@x.com'.length)}@x.com`;
    expect(atLimit).toHaveLength(MAX_EMAIL_LENGTH);
    expect(isEmailShaped(atLimit)).toBe(true);
    expect(isEmailShaped(`a${atLimit}`)).toBe(false);
  });

  /**
   * The reason this module exists.
   *
   * The input matters and the obvious guess is WRONG. A long dotless string
   * (`'a'*n + '@' + 'b'*n`) is linear — 0.1ms at 80k — because there is only
   * one candidate split and it fails immediately. The expensive shape is MANY
   * DOTS with a tail the class cannot match: `[^\s@]` contains the dot, so
   * each of the n dots is a candidate for the literal `\.`, and a trailing
   * space makes every one of them fail. Measured on the unguarded pattern:
   * 10k chars 26ms, 40k 396ms, 80k 1607ms — quadratic, and minutes at the 1MB
   * body limit the forgot-password route allows.
   *
   * A first version of this test used the dotless input, passed with the guard
   * REMOVED, and therefore proved nothing.
   */
  it('answers immediately on the quadratic input instead of backtracking', () => {
    const evil = `a@${'b.'.repeat(40_000)} `;
    const started = performance.now();
    expect(isEmailShaped(evil)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
