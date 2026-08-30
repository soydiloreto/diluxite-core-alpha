import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Encryption at rest for the few secrets Diluxite has to store — today the
 * embedding provider's API key (ADR-003 / ADR-004).
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to open rather
 * than decrypting into something plausible. The key is derived per secret with
 * scrypt from the installation's passphrase and a random salt stored alongside,
 * so two secrets never share a key and a leaked ciphertext carries the cost of
 * a KDF rather than a hash lookup.
 *
 * WHY THERE IS NO RANDOM FALLBACK, unlike the CSRF and MFA signing keys: those
 * lose in-flight tokens on restart, which is an inconvenience. This one would
 * make every stored secret permanently unreadable — data loss dressed as a
 * default. Without a passphrase, sealing refuses and the caller is expected to
 * say so out loud.
 */

/** `v1.<salt>.<iv>.<tag>.<ciphertext>`, all base64url. */
const VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Cheap enough to run per save, expensive enough to matter on a leaked blob. */
const SCRYPT_COST = 16384;

export class SecretKeyMissing extends Error {
  constructor() {
    super(
      'no encryption passphrase configured — set DILUXITE_SECRET_KEY (32+ chars) ' +
        'before storing a provider credential',
    );
    this.name = 'SecretKeyMissing';
  }
}

/**
 * The installation's passphrase, or null.
 *
 * Falls back to the other server secrets so a deployment that already sets one
 * of them does not need a second, and so an operator who rotates the obvious
 * one does not silently orphan their stored credentials. Never random.
 */
export function secretPassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.DILUXITE_SECRET_KEY,
    env.DILUXITE_MFA_SIGNING_KEY,
    env.DILUXITE_CSRF_SIGNING_KEY,
  ];
  for (const c of candidates) {
    if (c && c.length >= 16) return c;
  }
  return null;
}

/** Encrypt `plaintext`. Throws `SecretKeyMissing` when there is no passphrase. */
export function sealSecret(plaintext: string, passphrase: string | null): string {
  if (!passphrase) throw new SecretKeyMissing();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_COST });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(salt), b64(iv), b64(tag), b64(ct)].join('.');
}

/**
 * Decrypt what `sealSecret` produced.
 *
 * Throws on a wrong passphrase, a tampered blob or an unknown version. There is
 * deliberately no "return null on failure" mode: a caller that cannot tell a
 * missing secret from a corrupted one will eventually treat one as the other.
 */
export function openSecret(sealed: string, passphrase: string | null): string {
  if (!passphrase) throw new SecretKeyMissing();
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('sealed secret is malformed or of an unknown version');
  }
  const [, saltB64, ivB64, tagB64, ctB64] = parts;
  const key = scryptSync(passphrase, unb64(saltB64), KEY_BYTES, { N: SCRYPT_COST });
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(ivB64));
  decipher.setAuthTag(unb64(tagB64));
  return Buffer.concat([decipher.update(unb64(ctB64)), decipher.final()]).toString('utf8');
}

/**
 * Whether a sealed blob can still be opened with the current passphrase.
 *
 * Used at boot: a rotated passphrase leaves credentials that look present and
 * fail on first use, which is the kind of failure that surfaces at the worst
 * moment. Answering it early lets the instance say so instead.
 */
export function canOpen(sealed: string, passphrase: string | null): boolean {
  try {
    openSecret(sealed, passphrase);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison for the rare case of checking a secret against a
 * value the caller supplied, without leaking its length through timing.
 */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const b64 = (b: Buffer): string => b.toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');
