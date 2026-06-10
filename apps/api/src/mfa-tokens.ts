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
  // A per-mint random nonce makes every token UNIQUE — without it two logins
  // in the same second produce identical tokens, which then collide with the
  // single-use consumed-token set. The nonce is part of the signed payload.
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${userId}.${expiresAt}.${nonce}`;
  const mac = createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyMfaToken(token: string, now: number = Date.now()): MfaToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [userId, expiresStr, nonce, providedMac] = parts;
  if (!userId || !expiresStr || !nonce || !providedMac) return null;
  const expiresAt = Number(expiresStr);
  if (!Number.isFinite(expiresAt)) return null;
  if (Math.floor(now / 1000) > expiresAt) return null;
  const payload = `${userId}.${expiresAt}.${nonce}`;
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

// ── Per-user TOTP brute-force lockout ──────────────────────────────────────
//
// The IP rate-limit on /api/auth/login/totp is bypassable by rotating IPs (the
// 6-digit code space is small enough to brute-force across many IPs). So we
// ALSO track failed TOTP attempts per userId (derived from the mfaToken, which
// is HMAC-bound to the user — unforgeable). After MAX_TOTP_FAILS failures the
// user is locked out for LOCKOUT_MS regardless of source IP, and the specific
// mfaToken is consumed (single-use after the cap) so the attacker must restart
// the password step. State is in-memory: a single-node server's TOTP step is
// already serialised through one process; a restart clears the counters, which
// only ever HELPS a legitimate locked-out user and still forces the attacker
// back through the password gate.

/** Failures before a user is locked out of the TOTP step. */
export const MAX_TOTP_FAILS = 5;
/** How long the lockout lasts once tripped. */
export const TOTP_LOCKOUT_MS = 15 * 60 * 1000;

interface TotpAttemptState {
  fails: number;
  lockedUntil: number;
}
const totpAttempts = new Map<string, TotpAttemptState>();
// mfaTokens explicitly consumed (single-use once they hit the fail cap, or on
// successful login). Keyed by the token's MAC (its last segment) so we don't
// retain the whole token. Bounded by natural expiry sweeps below.
const consumedTokens = new Map<string, number>();

function tokenKey(token: string): string {
  // The signature (last segment) uniquely identifies a minted token now that
  // each carries a random nonce in the signed payload.
  const parts = token.split('.');
  return parts[parts.length - 1] || token;
}

/** True if this exact mfaToken was already consumed (single-use guard). */
export function isMfaTokenConsumed(token: string, now: number = Date.now()): boolean {
  const exp = consumedTokens.get(tokenKey(token));
  if (exp === undefined) return false;
  if (now > exp) {
    consumedTokens.delete(tokenKey(token));
    return false;
  }
  return true;
}

/** Mark an mfaToken as spent so it can't be replayed. */
export function consumeMfaToken(token: string, now: number = Date.now()): void {
  // Keep until just past the token's own TTL — no point holding longer.
  consumedTokens.set(tokenKey(token), now + TTL_SECONDS * 1000);
}

/** True if the user is currently locked out of the TOTP step. */
export function isUserTotpLocked(userId: string, now: number = Date.now()): boolean {
  const st = totpAttempts.get(userId);
  if (!st) return false;
  if (st.lockedUntil > now) return true;
  // Lock expired — reset so the user gets a fresh budget.
  if (st.lockedUntil !== 0 && st.lockedUntil <= now) {
    totpAttempts.delete(userId);
  }
  return false;
}

/**
 * Record a failed TOTP attempt for a user. Returns true once the failure cap
 * is reached (caller should also consume the mfaToken and answer "locked").
 */
export function recordTotpFailure(userId: string, now: number = Date.now()): boolean {
  const st = totpAttempts.get(userId) ?? { fails: 0, lockedUntil: 0 };
  st.fails += 1;
  if (st.fails >= MAX_TOTP_FAILS) {
    st.lockedUntil = now + TOTP_LOCKOUT_MS;
  }
  totpAttempts.set(userId, st);
  return st.fails >= MAX_TOTP_FAILS;
}

/** Clear a user's TOTP failure counter (called after a successful login). */
export function clearTotpFailures(userId: string): void {
  totpAttempts.delete(userId);
}

/** Test-only: wipe all per-user TOTP lockout + consumed-token state. */
export function _resetTotpLockoutState(): void {
  totpAttempts.clear();
  consumedTokens.clear();
}
