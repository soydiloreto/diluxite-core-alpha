/**
 * PBKDF2-SHA512 password hashing. Pure Node `crypto`, no native deps.
 *
 * Format: `pbkdf2$<iterations>$<saltHexBase64>$<hashHexBase64>`. The format
 * is self-describing so the iteration count can be bumped over time without
 * a flag-day migration — verify() reads it from the stored hash.
 *
 * 210_000 iterations matches OWASP's current PBKDF2-SHA512 recommendation
 * (Dec 2025). On modern hardware that's ~50ms per call — slow enough to
 * frustrate offline cracking, fast enough to not stall a login UX.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

const ITER = 210_000;
const KEYLEN = 64;
const DIGEST = 'sha512';

export function hashPassword(plaintext: string): string {
  if (!plaintext) throw new Error('password is empty');
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(plaintext, salt, ITER, KEYLEN, DIGEST);
  return `pbkdf2$${ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plaintext: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  const got = pbkdf2Sync(plaintext, salt, iter, expected.length, DIGEST);
  return got.length === expected.length && timingSafeEqual(got, expected);
}
