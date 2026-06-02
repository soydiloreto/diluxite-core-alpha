import crypto from 'node:crypto';

/**
 * CSRF defence — double-submit cookie pattern.
 *
 * Mechanism:
 *  1. When the server mints a session cookie (login / OIDC callback /
 *     passkey-sign-in), it also sets a sibling `diluxite_csrf` cookie. The
 *     CSRF cookie is NOT HttpOnly — the SPA reads it from `document.cookie`
 *     and echoes the value into the `X-CSRF-Token` header on every
 *     state-changing request.
 *  2. The server requires both: the cookie's value MUST match the header on
 *     POST/PUT/DELETE/PATCH. A cross-origin attacker can't read the cookie
 *     (Same-Origin Policy), so they can't forge a matching header — the
 *     request is rejected.
 *
 * Why this on top of `SameSite=Lax`?
 *  - SameSite=Lax stops the most common form-submission CSRF for cookie auth,
 *     but it's not a hermetic defence: some legacy navigations, subdomain
 *     trust, and bugs in browsers have leaked cookies cross-site before.
 *  - Defence-in-depth is the enterprise expectation. Adding the header check
 *     costs us almost nothing per request and is the OWASP-recommended pattern.
 *
 * Scope:
 *  - The check applies ONLY to requests that authenticate via the session
 *     cookie. Bearer-token requests (MCP clients, scripts, CLIs) are immune
 *     to CSRF by construction (no ambient credential), so we skip them.
 *  - GET / HEAD / OPTIONS are safe by HTTP semantics — no enforcement.
 *
 * Test/dev escape hatch: `DILUXITE_CSRF_DISABLED=1` skips the check globally.
 * The integration test suite sets this so it doesn't have to thread a CSRF
 * token through every cookie-authed request; a dedicated test file flips it
 * back on to prove the gate fires.
 */

export const CSRF_COOKIE = 'diluxite_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE_NAME = 'diluxite_session';

export function mintCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
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

/**
 * Stateless verification: pull session cookie + CSRF cookie + CSRF header
 * out of the request, return ok|fail decision.
 *
 * Returns `ok` (skip) when:
 *  - HTTP method is safe (GET/HEAD/OPTIONS).
 *  - Request carries an `Authorization: Bearer …` header (token auth, no CSRF risk).
 *  - Request has no session cookie at all (will fail auth elsewhere with 401).
 *
 * Returns `fail` when:
 *  - Session cookie is present but CSRF cookie is missing.
 *  - CSRF cookie is present but the X-CSRF-Token header is missing.
 *  - Cookie value and header value differ (constant-time compare).
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

  const cookieToken = extractCookie(CSRF_COOKIE, cookieHeader);
  if (!cookieToken) return { ok: false, reason: 'missing csrf cookie' };

  const headerToken = (req.headers[CSRF_HEADER] ??
    req.headers['X-CSRF-Token'] ??
    req.headers['X-Csrf-Token']) as string | undefined;
  if (!headerToken) return { ok: false, reason: 'missing csrf header' };

  const a = Buffer.from(cookieToken, 'utf8');
  const b = Buffer.from(headerToken, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'csrf mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'csrf mismatch' };
  return { ok: true };
}
