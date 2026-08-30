import { describe, it, expect } from 'vitest';
import {
  SecretKeyMissing,
  canOpen,
  openSecret,
  sealSecret,
  secretPassphrase,
  secretsEqual,
} from './secret-box';

const KEY = 'una-frase-de-paso-suficientemente-larga';

describe('secret box', () => {
  it('round-trips a secret', () => {
    const sealed = sealSecret('sk-abc123', KEY);
    expect(openSecret(sealed, KEY)).toBe('sk-abc123');
  });

  it('never stores the plaintext', () => {
    // The whole point. A sealed blob that contains its own secret would pass
    // the round-trip test above and fail the only thing it exists for.
    const sealed = sealSecret('sk-super-secreta', KEY);
    expect(sealed).not.toContain('sk-super-secreta');
    expect(Buffer.from(sealed, 'utf8').includes(Buffer.from('sk-super'))).toBe(false);
  });

  it('produces a different blob every time, for the same input', () => {
    // A deterministic ciphertext leaks equality: an operator could tell that
    // two organisations use the same key without decrypting anything.
    const a = sealSecret('misma', KEY);
    const b = sealSecret('misma', KEY);
    expect(a).not.toBe(b);
    expect(openSecret(a, KEY)).toBe(openSecret(b, KEY));
  });

  it('refuses a wrong passphrase rather than returning garbage', () => {
    const sealed = sealSecret('sk-abc', KEY);
    expect(() => openSecret(sealed, 'otra-frase-de-paso-larguisima')).toThrow();
  });

  it('detects tampering — the ciphertext is authenticated', () => {
    const sealed = sealSecret('sk-abc', KEY);
    const parts = sealed.split('.');
    // Flip one character of the ciphertext.
    const ct = parts[4];
    parts[4] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expect(() => openSecret(parts.join('.'), KEY)).toThrow();
  });

  it('rejects a blob of an unknown version instead of guessing', () => {
    const sealed = sealSecret('sk-abc', KEY).replace(/^v1/, 'v2');
    expect(() => openSecret(sealed, KEY)).toThrow(/version/i);
  });

  it('rejects a malformed blob', () => {
    expect(() => openSecret('no-es-un-blob', KEY)).toThrow();
    expect(() => openSecret('v1.a.b.c', KEY)).toThrow();
  });

  describe('the passphrase', () => {
    it('comes from the dedicated variable first', () => {
      expect(
        secretPassphrase({ DILUXITE_SECRET_KEY: 'x'.repeat(20), DILUXITE_MFA_SIGNING_KEY: 'y'.repeat(20) } as never),
      ).toBe('x'.repeat(20));
    });

    it('falls back to the other server secrets rather than demanding a new one', () => {
      expect(secretPassphrase({ DILUXITE_MFA_SIGNING_KEY: 'y'.repeat(20) } as never)).toBe('y'.repeat(20));
      expect(secretPassphrase({ DILUXITE_CSRF_SIGNING_KEY: 'z'.repeat(20) } as never)).toBe('z'.repeat(20));
    });

    it('ignores one that is too short to be a key', () => {
      expect(secretPassphrase({ DILUXITE_SECRET_KEY: 'corta' } as never)).toBeNull();
    });

    it('is NEVER randomly generated', () => {
      // The CSRF and MFA keys fall back to a per-process random value, which
      // costs in-flight tokens on restart. Doing that here would make every
      // stored credential permanently unreadable — data loss with a friendly
      // face. So: no passphrase, no sealing.
      expect(secretPassphrase({} as never)).toBeNull();
      expect(() => sealSecret('sk-abc', null)).toThrow(SecretKeyMissing);
      expect(() => openSecret('v1.a.b.c.d', null)).toThrow(SecretKeyMissing);
    });
  });

  describe('canOpen', () => {
    it('answers before the credential is needed, not when it is used', () => {
      const sealed = sealSecret('sk-abc', KEY);
      expect(canOpen(sealed, KEY)).toBe(true);
      // A rotated passphrase leaves credentials that look present and fail on
      // first use — at the worst possible moment. This is how a boot check
      // finds out early.
      expect(canOpen(sealed, 'una-frase-completamente-distinta')).toBe(false);
      expect(canOpen(sealed, null)).toBe(false);
    });
  });

  it('compares secrets without leaking length through an early return', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
  });
});
