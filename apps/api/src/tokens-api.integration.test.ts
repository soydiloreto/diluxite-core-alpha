import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { StoredTokenAuthProvider } from '@diluxite/core';
import { buildApp } from '../src/app';
import { buildTestApp } from '../test/helpers';

describe('API de tokens (integración)', () => {
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

  it('mintea un token (visible una vez), lo lista sin el valor y autentica con él', async () => {
    const mint = await app.inject({ method: 'POST', url: '/api/tokens', payload: { nombre: 'claude' } });
    expect(mint.statusCode).toBe(201);
    const token = mint.json().token as string;
    expect(token).toBeTruthy();

    const list = await app.inject({ url: '/api/tokens' });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].token).toBeUndefined(); // nunca se devuelve el valor de nuevo
    expect(list.json()[0].nombre).toBe('claude');

    // El token autentica vía StoredTokenAuthProvider
    const app2 = buildApp({ ...deps, auth: new StoredTokenAuthProvider(deps.tokens) });
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

  it('revoca un token y deja de autenticar', async () => {
    const token = (await app.inject({ method: 'POST', url: '/api/tokens', payload: {} })).json()
      .token as string;
    const id = (await app.inject({ url: '/api/tokens' })).json()[0].id as string;

    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${id}` })).statusCode).toBe(200);
    expect(await deps.tokens.findUserIdByToken(token)).toBeNull();
  });
});
