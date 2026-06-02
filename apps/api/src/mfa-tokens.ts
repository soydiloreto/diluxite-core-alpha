import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed tokens for the password→TOTP handoff.
 *
 * The login flow becomes:
 *   POST /api/auth/login (email+password OK) → `{requiresMfa:true, mfaToken}`
 *   POST /api/auth/login/totp (mfaToken + code) → cookie session
 *
 * `mfaToken` is opaque to the client: `<userId>.<expiresAt>.<hmac>`. The
 * HMAC binds the tuple to the server's signing key — no DB lookup needed,
 * and an attacker who intercepts a token can't reuse it past `expiresAt`
 * or forge a different `userId`.
 *
 * Signing key: `DILUXITE_MFA_SIGNING_KEY` env var, OR derived from
 * `DILUXITE_ADMIN_PASSWORD` (server mode always has it), OR a process-local
 * random fallback. The fallback rotates on restart, which IS a tradeoff:
 * pending mfaTokens get invalidated after a deploy. We log a warning so
 * operators know to set the env var explicitly in production.
 */

const TTL_SECONDS = 5 * 60; // 5 minutes — well within the user's "I'll open my authenticator app" window

let keyCache: Buffer | null = null;
function signingKey(): Buffer {
  if (keyCache) return keyCache;
  const fromEnv = process.env.DILUXITE_MFA_SIGNING_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    keyCache = Buffer.from(fromEnv);
    return keyCache;
  }
  const fromAdmin = process.env.DILUXITE_ADMIN_PASSWORD;
  if (fromAdmin && fromAdmin.length >= 8) {
    // Derive a per-install secret. Better than a fixed string but still
    // process-local — the admin password isn't rotation-safe either, so
    // operators that care should set DILUXITE_MFA_SIGNING_KEY explicitly.
    keyCache = Buffer.from(`mfa::${fromAdmin}::v1`);
    return keyCache;
  }
  keyCache = randomBytes(32);
  console.warn(
    '⚠️  DILUXITE_MFA_SIGNING_KEY not set — using a random key for this process. ' +
      'Pending MFA tokens will not survive restarts. Set the env var for stable behaviour.',
  );
  return keyCache;
}

export interface MfaToken {
  userId: string;
  expiresAt: number;
}

export function mintMfaToken(userId: string, now: number = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + TTL_SECONDS;
  const payload = `${userId}.${expiresAt}`;
  const mac = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyMfaToken(token: string, now: number = Date.now()): MfaToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expiresStr, providedMac] = parts;
  if (!userId || !expiresStr || !providedMac) return null;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt)) return null;
  if (Math.floor(now / 1000) > expiresAt) return null;
  const payload = `${userId}.${expiresAt}`;
  const expectedMac = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  const a = Buffer.from(providedMac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { userId, expiresAt };
}

/** Test-only: reset the key cache so tests can swap env vars. */
export function _resetMfaKeyCache(): void {
  keyCache = null;
}
