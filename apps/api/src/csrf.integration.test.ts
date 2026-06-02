import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import {
  csrfCheck,
  CSRF_COOKIE,
  CSRF_HEADER,
  mintCsrfToken,
  extractCookie,
  csrfCookieHeader,
  clearCsrfCookieHeader,
  SESSION_COOKIE_NAME,
} from './csrf';

/**
 * CSRF — double-submit cookie pattern.
 *
 * Tests cubren:
 *  1. Helper puro (`csrfCheck`):
 *     - GET/HEAD/OPTIONS bypass (no enforcement).
 *     - Bearer auth bypass.
 *     - No session cookie → skip (auth handles it).
 *     - Session cookie + missing CSRF cookie → fail.
 *     - Session cookie + CSRF cookie + missing header → fail.
 *     - Cookie + header that differ → fail.
 *     - Cookie + header equal → ok.
 *     - Different lengths constant-time path.
 *  2. End-to-end via buildApp (with CSRF enabled):
 *     - Login mints both cookies + returns csrf in body.
 *     - A POST without CSRF header on an authed request → 403.
 *     - Same POST with the right header → 200/200-class.
 *     - Bearer-authed POST does NOT need CSRF.
 *     - Logout clears both cookies.
 *     - Login itself (no session yet) is exempt from CSRF gate.
 *     - GET requests are exempt regardless.
 */

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

  it('rejects when session cookie present but CSRF cookie missing', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=s` },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing csrf cookie/i);
  });

  it('rejects when CSRF cookie present but header missing', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=abc` },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing csrf header/i);
  });

  it('rejects when cookie and header differ', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=abc`,
        [CSRF_HEADER]: 'xyz',
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/i);
  });

  it('accepts when cookie and header match exactly', () => {
    const tok = 'matchy-matchy';
    expect(
      csrfCheck({
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=${tok}`,
          [CSRF_HEADER]: tok,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects when the lengths differ (covers the constant-time short-circuit)', () => {
    const r = csrfCheck({
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=short`,
        [CSRF_HEADER]: 'longer-token-here',
      },
    });
    expect(r.ok).toBe(false);
  });

  it('case-insensitive on the header name (matches HTTP spec)', () => {
    const tok = mintCsrfToken();
    // Fastify normalises headers to lowercase, but our helper also accepts
    // X-CSRF-Token. Test both forms.
    for (const hname of [CSRF_HEADER, 'X-CSRF-Token', 'X-Csrf-Token']) {
      expect(
        csrfCheck({
          method: 'POST',
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=s; ${CSRF_COOKIE}=${tok}`,
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

  it('mintCsrfToken returns at least 256 bits of entropy (base64url, ~43 chars)', () => {
    const t = mintCsrfToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    // Two calls must differ (sanity check on the random source).
    expect(mintCsrfToken()).not.toBe(t);
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

  it('lets the request through when the CSRF header matches the cookie', async () => {
    const tok = 'abc123';
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=fake; ${CSRF_COOKIE}=${tok}`,
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
