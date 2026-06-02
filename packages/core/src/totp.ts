import { createHmac, randomBytes, createHash } from 'node:crypto';

/**
 * RFC 6238 TOTP — Time-based One-Time Passwords.
 *
 * Compatible con Google Authenticator / 1Password / Authy / Entra ID Authenticator.
 * Default: HMAC-SHA1, 30s period, 6 digits. Esos son los valores que los
 * authenticator apps esperan; cambiarlos rompe la compatibilidad sin upside.
 *
 * Verification accepts the previous AND next time-step (±1 window). Cubre
 * el caso de clock drift entre el server y el dispositivo del usuario (más
 * común de lo que uno cree — 30s no es mucho margen).
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20; // 160 bits — matches what otpauth URIs typically use

/** Generates a fresh random secret encoded in base32 (case insensitive). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * Builds the `otpauth://totp/...` URL the authenticator apps consume from a
 * QR code. Includes issuer + account so the user sees "Diluxite (you@example.com)"
 * after scanning.
 */
export function buildOtpauthUrl(opts: {
  issuer: string;
  accountName: string;
  secret: string;
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Computes the TOTP code for a given timestamp. Public so tests can pin
 * the clock; in the endpoint we always pass `Date.now()`.
 */
export function generateTotpCode(secret: string, now: number = Date.now()): string {
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  return hotp(secret, counter);
}

/**
 * Verifies a user-supplied code against a secret. Accepts ±1 time-step to
 * tolerate clock drift (~30s either way). Returns boolean — caller decides
 * how to react (rate-limit, audit, lock).
 *
 * The input code is trimmed and zero-padded so '012345' / '12345' / ' 12345 '
 * all parse as 12345. We require exactly TOTP_DIGITS once normalised.
 */
export function verifyTotpCode(secret: string, supplied: string, now: number = Date.now()): boolean {
  const normalised = supplied.trim();
  if (!/^[0-9]+$/.test(normalised)) return false;
  if (normalised.length > TOTP_DIGITS) return false;
  const padded = normalised.padStart(TOTP_DIGITS, '0');
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  for (const offset of [-1, 0, 1]) {
    if (constantTimeEqual(hotp(secret, counter + offset), padded)) return true;
  }
  return false;
}

/**
 * Generates N backup codes (8 hex chars each = ~32 bits of entropy each).
 * Returns the plaintext codes for the UI to display ONCE, and their hashes
 * for persistence. Hashing is just SHA-256: backup codes are single-use,
 * leaking the DB lets an attacker burn one and we'd notice (used flag).
 */
export function generateBackupCodes(n: number = 10): {
  plaintext: string[];
  hashes: string[];
} {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < n; i++) {
    const code = randomBytes(4).toString('hex'); // 8 hex chars
    plaintext.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plaintext, hashes };
}

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

// ── Internals ───────────────────────────────────────────────────────────────

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
  return code;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
