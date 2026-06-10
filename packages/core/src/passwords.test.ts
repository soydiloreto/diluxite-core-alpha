import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';

describe('passwords (PBKDF2-SHA512)', () => {
  it('hashPassword produces the documented format', () => {
    const h = hashPassword('correct horse battery staple');
    const parts = h.split('$');
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBeGreaterThanOrEqual(210_000);
    expect(parts[2].length).toBeGreaterThan(10); // salt base64
    expect(parts[3].length).toBeGreaterThan(10); // hash base64
  });

  it('hashes are salted (two hashes of the same password differ)', () => {
    expect(hashPassword('abc')).not.toBe(hashPassword('abc'));
  });

  it('verifyPassword returns true for the right password', () => {
    const h = hashPassword('s3cret');
    expect(verifyPassword('s3cret', h)).toBe(true);
  });

  it('verifyPassword returns false for the wrong password', () => {
    const h = hashPassword('s3cret');
    expect(verifyPassword('s3cret!', h)).toBe(false);
    expect(verifyPassword('S3cret', h)).toBe(false);
    expect(verifyPassword('', h)).toBe(false);
  });

  it('verifyPassword returns false for null/malformed stored values', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'not-our-format')).toBe(false);
    expect(verifyPassword('x', 'pbkdf2$0$a$b')).toBe(false); // iter too low
  });

  it('verifyPassword returns false (no throw) for empty or garbage base64 parts', () => {
    expect(verifyPassword('x', 'pbkdf2$210000$c2FsdA==$')).toBe(false); // empty hash
    expect(verifyPassword('x', 'pbkdf2$210000$$c2FsdA==')).toBe(false); // empty salt
    expect(verifyPassword('x', 'pbkdf2$210000$!!!$@@@')).toBe(false); // garbage base64
  });

  it('hashPassword refuses empty plaintext', () => {
    expect(() => hashPassword('')).toThrow(/empty/);
  });
});
