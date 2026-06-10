import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AuthProvider } from '@diluxite/core';
import { buildApp } from './app';
import { buildTestApp } from '../test/helpers';

/**
 * Passkey (WebAuthn) endpoint wiring + gates. La verificación criptográfica de
 * la ceremonia la hace @simplewebauthn (librería ya testeada); acá probamos lo
 * NUESTRO: el gate de server-mode, la auth, el manejo de body inválido y que
 * `register-options` emita opciones WebAuthn válidas + guarde el challenge.
 */

function serverDeps(
  base: Awaited<ReturnType<typeof buildTestApp>>['deps'],
  auth: AuthProvider,
) {
  return { ...base, info: { ...(base.info ?? { embedder: 'local', version: '0' }), authMode: 'server' as const }, auth };
}

describe('passkey routes', () => {
  let app: FastifyInstance;
  let sql: Sql;
  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('returns 404 in local mode (server-mode gate)', async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/register-options' });
    expect(r.statusCode).toBe(404);
  });

  it('server mode: register-options returns WebAuthn options and stores the challenge', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/register-options' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(typeof body.challenge).toBe('string');
    expect(body.rp.id).toBe('localhost');
    // UV is 'required' to match verifyRegistrationResponse's default (#4f).
    expect(body.authenticatorSelection.userVerification).toBe('required');

    // El challenge quedó persistido (consumible una sola vez).
    const taken = await t.deps.passkeys!.takeChallenge(body.challenge, 'registration');
    expect(taken?.userId).toBe(t.userId);
  });

  it('server mode: register-options without identity → 401', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => null }));
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/register-options' });
    expect(r.statusCode).toBe(401);
  });

  it('server mode: register-verify without a response body → 400', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register-verify',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('authenticate-options requests userVerification=required (#4f)', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => null }));
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/authenticate-options' });
    expect(r.statusCode).toBe(200);
    // Must match verifyAuthenticationResponse's default requireUserVerification.
    expect(r.json().userVerification).toBe('required');
  });
});
