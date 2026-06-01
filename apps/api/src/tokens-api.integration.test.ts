import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { StoredTokenAuthProvider } from '@diluxite/core';
import { buildApp } from '../src/app';
import { buildTestApp } from '../test/helpers';

describe('Tokens API (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: Awaited<ReturnType<typeof buildTestApp>>['deps'];

  beforeEach(async () => {
    ({ app, sql, deps } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('mints a token (visible once), lists it without the value, and authenticates with it', async () => {
    const mint = await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'claude' } });
    expect(mint.statusCode).toBe(201);
    const token = mint.json().token as string;
    expect(token).toBeTruthy();

    const list = await app.inject({ url: '/api/tokens' });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].token).toBeUndefined(); // cleartext is never returned again
    expect(list.json()[0].name).toBe('claude');

    // The token authenticates via StoredTokenAuthProvider
    const app2 = await buildApp({ ...deps, auth: new StoredTokenAuthProvider(deps.tokens) });
    await app2.ready();
    try {
      const ok = await app2.inject({ url: '/api/spaces', headers: { authorization: `Bearer ${token}` } });
      expect(ok.statusCode).toBe(200);
      const bad = await app2.inject({ url: '/api/spaces', headers: { authorization: 'Bearer nope' } });
      expect(bad.statusCode).toBe(401);
    } finally {
      await app2.close();
    }
  });

  it('mints with TTL — expired tokens stop authenticating', async () => {
    // Manual expiry via SQL is the only way to test "past expiry" without
    // sleeping for real. The flow: mint with TTL, push expiry to past,
    // verify StoredTokenAuthProvider rejects.
    const mint = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'short-lived', expiresInDays: 7 },
    });
    expect(mint.statusCode).toBe(201);
    const token = mint.json().token as string;
    expect(mint.json().expiresAt).toBeTruthy();
    expect(new Date(mint.json().expiresAt as string).getTime()).toBeGreaterThan(Date.now());

    await sql`UPDATE tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE name = 'short-lived'`;

    const app2 = await buildApp({ ...deps, auth: new StoredTokenAuthProvider(deps.tokens) });
    await app2.ready();
    try {
      const r = await app2.inject({
        url: '/api/spaces',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode).toBe(401);
    } finally {
      await app2.close();
    }
  });

  it('mintToken without expiresInDays returns expiresAt: null (legacy behaviour)', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      payload: { name: 'forever' },
    });
    expect(mint.statusCode).toBe(201);
    expect(mint.json().expiresAt).toBeNull();
  });

  it('POST /api/tokens/revoke-all wipes every token for the caller', async () => {
    for (const n of ['a', 'b', 'c']) {
      await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: n } });
    }
    expect((await app.inject({ url: '/api/tokens' })).json()).toHaveLength(3);

    const r = await app.inject({ method: 'POST', url: '/api/tokens/revoke-all' });
    expect(r.statusCode).toBe(200);
    expect(r.json().revoked).toBe(3);
    expect((await app.inject({ url: '/api/tokens' })).json()).toHaveLength(0);
  });

  it('revokes a token and it stops authenticating', async () => {
    const token = (await app.inject({ method: 'POST', url: '/api/tokens', payload: {} })).json()
      .token as string;
    const id = (await app.inject({ url: '/api/tokens' })).json()[0].id as string;

    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${id}` })).statusCode).toBe(200);
    expect(await deps.tokens.findUserIdByToken(token)).toBeNull();
  });
});
