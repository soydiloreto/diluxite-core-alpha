import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import { SingleUserAuthProvider } from '@diluxite/core';

/**
 * Rate-limit gate on /api/auth/login (and passkey ceremony endpoints).
 *
 * The test enables the rate-limit plugin explicitly (the rest of the api
 * integration suite sets DILUXITE_RATE_LIMIT_DISABLED=1 to keep their
 * flood-the-endpoint scenarios working). We hit the login endpoint six
 * times with wrong credentials; the first five must be 401 (invalid
 * credentials), the sixth must be 429 (rate limited).
 *
 * Why no DB / no real users: the rate limit happens BEFORE the credentials
 * check, so we don't need server mode to assert it triggers — we only need
 * a buildApp() that returns something. We stub the minimum AppDeps for that.
 */

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
    move: {} as never,
    auth: new SingleUserAuthProvider('test-user'),
    info: { embedder: 'local', version: '0.0.0', authMode: 'local' },
  };
}

describe('rate-limit: /api/auth/login', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.DILUXITE_RATE_LIMIT_DISABLED;
    app = await buildApp(stubDeps());
    await app.ready();
  });

  afterEach(async () => {
    process.env.DILUXITE_RATE_LIMIT_DISABLED = '1';
    await app.close();
  });

  it('returns 429 after exceeding the per-IP login budget', async () => {
    // First 5 requests: bounce on the local-mode guard (404) since we're not
    // in server mode. The rate-limit plugin still counts them.
    // The 6th request must be 429 from the rate limiter, BEFORE the handler
    // even runs.
    //
    // The key is req.ip (the socket address `app.inject` fakes), NOT the
    // X-Forwarded-For header — that one is client-controlled and ignored
    // unless trustProxy (DILUXITE_TRUST_PROXY=1) is on.
    const headers = {
      'content-type': 'application/json',
    };
    const payload = JSON.stringify({ email: 'a@x', password: 'wrong' });

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers,
        payload,
      });
      codes.push(r.statusCode);
    }

    // First 5 hit the handler (404 because authMode is 'local'; in 'server'
    // mode they'd be 401). The 6th gets stopped by rate limit.
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes[5]).toBe(429);
  });

  it('429 response includes a Retry-After header so clients can back off', async () => {
    const headers = {
      'content-type': 'application/json',
    };
    const payload = JSON.stringify({ email: 'a@x', password: 'wrong' });
    // Drain the budget first.
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload });
    }
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload });
    expect(r.statusCode).toBe(429);
    // @fastify/rate-limit emits a numeric retry-after (seconds) or HTTP-date.
    const retry = r.headers['retry-after'];
    expect(retry).toBeTruthy();
  });

  it('spoofing a different X-Forwarded-For per request does NOT bypass the limit', async () => {
    // trustProxy is OFF by default, so the limiter keys on the socket address
    // and a rotating client-supplied XFF must be irrelevant. This used to be
    // a real bypass: the keyGenerator read the raw header.
    const payload = JSON.stringify({ email: 'a@x', password: 'wrong' });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${i + 1}`, // a "new IP" every request
        },
        payload,
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(codes[5]).toBe(429);
  });
});

describe('rate-limit: not applied to other endpoints', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    delete process.env.DILUXITE_RATE_LIMIT_DISABLED;
    app = await buildApp(stubDeps());
    await app.ready();
  });

  afterEach(async () => {
    process.env.DILUXITE_RATE_LIMIT_DISABLED = '1';
    await app.close();
  });

  it('does NOT rate-limit /health (10 hits in a row, all 200)', async () => {
    // Critical to assert: rate-limit is opt-in per-route (`global: false` in
    // the plugin config). If someone changes the plugin to global by accident
    // it would silently throttle health-checks and break monitoring.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).toBe(200);
    }
  });
});
