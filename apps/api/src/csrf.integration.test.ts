import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import {
  csrfCheck,
  CSRF_COOKIE,
  CSRF_HEADER,
  mintCsrfToken,
  csrfTokenForSession,
  extractCookie,
  csrfCookieHeader,
  clearCsrfCookieHeader,
  SESSION_COOKIE_NAME,
  _resetCsrfKeyCache,
} from './csrf';

/**
 * CSRF — session-bound double-submit cookie.
 *
 * Tests cubren:
 *  1. Helper puro (`csrfCheck`):
 *     - GET/HEAD/OPTIONS bypass (no enforcement).
 *     - Bearer auth bypass.
 *     - No session cookie → skip (auth handles it).
 *     - Session cookie present + missing header → fail.
 *     - Header that isn't bound to the session → fail.
 *     - Header == HMAC(sessionToken) → ok.
 *     - Token from session A does NOT validate for session B (the whole point).
 *  2. End-to-end via buildApp (with CSRF enabled):
 *     - A POST without CSRF header on an authed request → 403.
 *     - Same POST with the session-bound token → passes the gate.
 *     - Bearer-authed POST does NOT need CSRF.
 *     - Login itself (no session yet) is exempt from CSRF gate.
 *     - GET requests are exempt regardless.
 */

// Stable key so derived tokens are deterministic across the helper tests.
process.env.DILUXITE_CSRF_SIGNING_KEY = 'test-csrf-key-0123456789abcdef';
_resetCsrfKeyCache();

describe('csrfCheck — pure helper', () => {
  it('returns ok for safe HTTP methods (GET/HEAD/OPTIONS)', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        csrfCheck({
          method,
          headers: { cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=t` },
        }),
      ).toEqual({ ok: true });
    }
  });

  it('returns ok when Authorization: Bearer is present (token auth, no CSRF risk)', () => {
    expect(
      csrfCheck({
        method: 'POST',
        headers: {
          authorization: 'Bearer abc.def.ghi',
          cookie: `${SESSION_COOKIE_NAME}=s`,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('returns ok when there is no session cookie (will fail auth elsewhere)', () => {
    expect(
      csrfCheck({
        method: 'POST',
        headers: { cookie: 'something_else=foo' },
      }),
    ).toEqual({ ok: true });
    // Even without any cookies at all.
    expect(csrfCheck({ method: 'POST', headers: {} })).toEqual({ ok: true });
  });

  it('rejects when session cookie present but CSRF header missing', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=s` },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing csrf header/i);
  });

  it('rejects when the header is not the token bound to the session', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=s`,
        [CSRF_HEADER]: 'xyz',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/i);
  });

  it('accepts when the header is HMAC(sessionToken)', () => {
    const tok = csrfTokenForSession('s');
    expect(
      csrfCheck({
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=s`,
          [CSRF_HEADER]: tok,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("session A's token does NOT validate for session B (cookie-injection defence)", () => {
    const tokA = csrfTokenForSession('session-a');
    // Attacker plants session B's cookie but only knows session A's token.
    const r = csrfCheck({
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=session-b`,
        [CSRF_HEADER]: tokA,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/i);
    // ...but it DOES validate for its own session.
    expect(
      csrfCheck({
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=session-a`,
          [CSRF_HEADER]: tokA,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('case-insensitive on the header name (matches HTTP spec)', () => {
    const tok = csrfTokenForSession('s');
    // Fastify normalises headers to lowercase, but our helper also accepts
    // X-CSRF-Token. Test both forms.
    for (const hname of [CSRF_HEADER, 'X-CSRF-Token', 'X-Csrf-Token']) {
      expect(
        csrfCheck({
          method: 'POST',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=s`,
            [hname]: tok,
          },
        }),
      ).toEqual({ ok: true });
    }
  });

  it('all state-changing methods (POST/PUT/DELETE/PATCH) are enforced', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = csrfCheck({
        method,
        headers: { cookie: `${SESSION_COOKIE_NAME}=s` },
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe('csrfCookieHeader / clearCsrfCookieHeader / extractCookie', () => {
  it('csrfCookieHeader is NOT HttpOnly (JS must read it)', () => {
    const h = csrfCookieHeader('tok', 3600);
    expect(h).toContain(`${CSRF_COOKIE}=tok`);
    expect(h).not.toMatch(/HttpOnly/);
    expect(h).toMatch(/SameSite=Lax/);
    expect(h).toMatch(/Max-Age=3600/);
    expect(h).toMatch(/Path=\//);
  });

  it('clearCsrfCookieHeader emits Max-Age=0', () => {
    expect(clearCsrfCookieHeader()).toMatch(/Max-Age=0/);
  });

  it('extractCookie parses values out of a Cookie header (multiple pairs)', () => {
    expect(extractCookie('foo', 'a=1; foo=hello; bar=2')).toBe('hello');
    expect(extractCookie('absent', 'a=1; b=2')).toBeNull();
    expect(extractCookie('foo', undefined)).toBeNull();
  });

  it('extractCookie handles values with = sign inside', () => {
    expect(extractCookie('token', 'token=abc=def==; other=1')).toBe('abc=def==');
  });

  it('mintCsrfToken is deterministic per session token (base64url HMAC)', () => {
    const t = mintCsrfToken('session-token-x');
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // Same session → same token (so the cookie keeps validating).
    expect(mintCsrfToken('session-token-x')).toBe(t);
    // Different session → different token.
    expect(mintCsrfToken('session-token-y')).not.toBe(t);
  });
});

// ── End-to-end via buildApp (real Fastify, real CSRF preHandler) ────────────

function stubDeps(): AppDeps {
  return {
    notes: {} as never,
    search: {} as never,
    spaces: {} as never,
    organizations: {} as never,
    users: {} as never,
    tokens: {} as never,
    tags: {} as never,
    links: {} as never,
    folders: {} as never,
    auth: { resolve: async () => null } as never,
    info: { embedder: 'local', version: '0.0.0', authMode: 'local' },
  };
}

describe('CSRF gate — end-to-end', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.DILUXITE_CSRF_DISABLED;
    app = await buildApp(stubDeps());
    await app.ready();
  });

  afterAll(() => {
    process.env.DILUXITE_CSRF_DISABLED = '1';
  });

  it('rejects a POST that carries a session cookie but no CSRF', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=fake-session-token`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/csrf/i) });
    await app.close();
  });

  it('lets the request through when the header is the session-bound token', async () => {
    const session = 'fake-session';
    const tok = csrfTokenForSession(session);
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE}=${tok}`,
        [CSRF_HEADER]: tok,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    // CSRF passes — but auth fails (we didn't wire a real user), so 401.
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('does NOT enforce CSRF on GET (safe method)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/notes/spaces',
      headers: { cookie: `${SESSION_COOKIE_NAME}=fake` },
    });
    expect(r.statusCode).not.toBe(403);
    await app.close();
  });

  it('does NOT enforce CSRF on a Bearer-authenticated POST', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        authorization: 'Bearer some-token-here',
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    // CSRF passes — auth fails (token not real).
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('login endpoint is exempt from CSRF gate (no session yet)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    });
    // 404 because authMode=local in this stub — but CSRF didn't block.
    expect(r.statusCode).not.toBe(403);
    await app.close();
  });

  it('a request with no cookies at all just hits auth (401), not CSRF (403)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('rejects when CSRF header is set but cookie is missing (asymmetric attack)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=fake`,
        [CSRF_HEADER]: 'attacker-supplied',
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/csrf/i) });
    await app.close();
  });
});

describe('CSRF gate — disabled mode (default for the rest of the suite)', () => {
  it('with DILUXITE_CSRF_DISABLED=1 nothing is rejected for missing CSRF', async () => {
    process.env.DILUXITE_CSRF_DISABLED = '1';
    const app = await buildApp(stubDeps());
    await app.ready();
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=fake`,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    // 401 (auth), not 403 (CSRF) — proves the gate is off.
    expect(r.statusCode).toBe(401);
    await app.close();
  });
});

// Note: end-to-end with a real login flow (server-mode bootstrap, password
// verify, real CSRF token in body) is covered by the manual smoke + the
// passkey-routes integration suite. Here we keep the focus on the gate
// helper + the preHandler decision tree.
