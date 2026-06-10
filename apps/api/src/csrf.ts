import crypto from 'node:crypto';

/**
 * CSRF defence — session-bound double-submit cookie.
 *
 * Mechanism:
 *  1. When the server mints a session cookie (login / OIDC callback /
 *     passkey-sign-in), it derives a sibling `diluxite_csrf` cookie whose value
 *     is `HMAC(sessionToken, serverSecret)`. The CSRF cookie is NOT HttpOnly —
 *     the SPA reads it from `document.cookie` and echoes the value into the
 *     `X-CSRF-Token` header on every state-changing request.
 *  2. The server requires the header to equal `HMAC(sessionCookie, secret)` for
 *     the session cookie ACTUALLY presented on the request. Not just
 *     "cookie === header": the token is cryptographically bound to *that*
 *     session, so a token belonging to a different session is rejected.
 *
 * Why session-bound and not plain double-submit?
 *  - Plain double-submit (cookie random, compare cookie === header) only proves
 *    the caller could read a cookie. An attacker who can SET a cookie on the
 *    victim's browser from a sibling subdomain (cookie injection / subdomain
 *    takeover) can plant a matching pair and defeat the check. Binding the
 *    token to the server-side session secret means the attacker would need the
 *    secret to forge a token for the victim's session — they can't.
 *  - SameSite=Lax + this check is the OWASP-recommended defence-in-depth combo.
 *
 * Scope:
 *  - The check applies ONLY to requests that authenticate via the session
 *     cookie. Bearer-token requests (MCP clients, scripts, CLIs) are immune
 *     to CSRF by construction (no ambient credential), so we skip them.
 *  - GET / HEAD / OPTIONS are safe by HTTP semantics — no enforcement.
 *  - A request with no session cookie skips (it'll 401 at the auth gate); the
 *     pre-login flow (login / OIDC handshake) therefore never breaks.
 *
 * Server secret:
 *  - `DILUXITE_CSRF_SIGNING_KEY` env var, OR derived from
 *    `DILUXITE_MFA_SIGNING_KEY` / `DILUXITE_ADMIN_PASSWORD` with the same
 *    strategy as mfa-tokens, OR a process-local random fallback (rotates on
 *    restart → in-flight CSRF tokens invalidate after a deploy, logged once).
 *    Documented in .env.example.
 *
 * Test/dev escape hatch: `DILUXITE_CSRF_DISABLED=1` skips the check globally.
 * The integration test suite sets this so it doesn't have to thread a CSRF
 * token through every cookie-authed request; a dedicated test file flips it
 * back on to prove the gate fires.
 */

export const CSRF_COOKIE = 'diluxite_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE_NAME = 'diluxite_session';

let keyCache: Buffer | null = null;
function signingKey(): Buffer {
  if (keyCache) return keyCache;
  const fromEnv = process.env.DILUXITE_CSRF_SIGNING_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    keyCache = Buffer.from(fromEnv);
    return keyCache;
  }
  // Reuse the MFA signing key when present — both are "this install's server
  // secret"; a dedicated one (above) is preferred but not required.
  const fromMfa = process.env.DILUXITE_MFA_SIGNING_KEY;
  if (fromMfa && fromMfa.length >= 16) {
    keyCache = Buffer.from(`csrf::${fromMfa}::v1`);
    return keyCache;
  }
  const fromAdmin = process.env.DILUXITE_ADMIN_PASSWORD;
  if (fromAdmin && fromAdmin.length >= 8) {
    keyCache = Buffer.from(`csrf::${fromAdmin}::v1`);
    return keyCache;
  }
  keyCache = crypto.randomBytes(32);
  console.warn(
    '⚠️  DILUXITE_CSRF_SIGNING_KEY not set — using a random key for this process. ' +
      'Existing CSRF tokens will not survive restarts. Set the env var for stable behaviour.',
  );
  return keyCache;
}

/** Test-only: reset the key cache so tests can swap env vars. */
export function _resetCsrfKeyCache(): void {
  keyCache = null;
}

/**
 * Derive the CSRF token bound to a given session token. Deterministic:
 * `HMAC(sessionToken, serverSecret)`. The same session always yields the same
 * CSRF token, so the cookie minted at login keeps validating for the life of
 * the session without any server-side storage.
 */
export function csrfTokenForSession(sessionToken: string): string {
  return crypto
    .createHmac('sha256', signingKey())
    .update(sessionToken)
    .digest('base64url');
}

/**
 * Mint a CSRF token for the session being created. Bound to `sessionToken`.
 * Kept as the public name the auth handlers call; they pass the freshly
 * minted session token so the cookie value matches what `csrfCheck` expects.
 */
export function mintCsrfToken(sessionToken: string): string {
  return csrfTokenForSession(sessionToken);
}

/**
 * The CSRF cookie is intentionally NOT HttpOnly: client JS must read it to
 * echo into the X-CSRF-Token header. SameSite=Lax matches the session cookie
 * so the two travel together on top-level navigations.
 */
export function csrfCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearCsrfCookieHeader(): string {
  return `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}

export function extractCookie(name: string, cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(/;\s*/)) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    if (pair.slice(0, idx) === name) return pair.slice(idx + 1);
  }
  return null;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export type CsrfDecision = { ok: true } | { ok: false; reason: string };

/** Constant-time equality on two base64url strings. */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Stateless verification: pull session cookie + CSRF header out of the request
 * and validate the header is the CSRF token bound to THIS session.
 *
 * Returns `ok` (skip) when:
 *  - HTTP method is safe (GET/HEAD/OPTIONS).
 *  - Request carries an `Authorization: Bearer …` header (token auth, no CSRF risk).
 *  - Request has no session cookie at all (will fail auth elsewhere with 401).
 *
 * Returns `fail` when:
 *  - Session cookie is present but the X-CSRF-Token header is missing.
 *  - The header value isn't the token bound to the presented session cookie
 *    (covers the cross-session-token attack: session A's token won't validate
 *    for a request carrying session B's cookie).
 */
export function csrfCheck(req: {
  method: string;
  headers: Record<string, unknown>;
}): CsrfDecision {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return { ok: true };

  const auth = (req.headers['authorization'] ?? req.headers['Authorization']) as
    | string
    | undefined;
  if (auth && /^bearer\s+/i.test(auth)) return { ok: true };

  const cookieHeader = (req.headers['cookie'] ?? req.headers['Cookie']) as string | undefined;
  const sessionToken = extractCookie(SESSION_COOKIE_NAME, cookieHeader);
  if (!sessionToken) return { ok: true };

  const headerToken = (req.headers[CSRF_HEADER] ??
    req.headers['X-CSRF-Token'] ??
    req.headers['X-Csrf-Token']) as string | undefined;
  if (!headerToken) return { ok: false, reason: 'missing csrf header' };

  // The token MUST be the one bound to the session cookie actually presented.
  // A token minted for a different session won't match this HMAC.
  const expected = csrfTokenForSession(sessionToken);
  if (!tokensEqual(expected, headerToken)) {
    return { ok: false, reason: 'csrf mismatch' };
  }
  return { ok: true };
}
