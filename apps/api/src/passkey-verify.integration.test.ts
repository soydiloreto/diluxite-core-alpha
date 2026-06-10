import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AuthProvider } from '@diluxite/core';
import { buildApp } from './app';
import { buildTestApp } from '../test/helpers';

/**
 * Passkey VERIFY error branches. Acá no usamos un autenticador real: cubrimos
 * los caminos de RECHAZO (challenge inválido/expirado, challenge de otro
 * usuario, body inválido, gate de server-mode), que es donde están las líneas
 * sin cubrir de `passkey-routes.ts`. La verificación criptográfica feliz la
 * hace @simplewebauthn (ya testeada) y requeriría un autenticador real.
 */

function serverDeps(
  base: Awaited<ReturnType<typeof buildTestApp>>['deps'],
  auth: AuthProvider,
) {
  return {
    ...base,
    info: { ...(base.info ?? { embedder: 'local', version: '0' }), authMode: 'server' as const },
    auth,
  };
}

/** clientDataJSON que el handler espera: base64url de JSON con `.challenge`. */
function clientDataFor(challenge: string): string {
  return Buffer.from(JSON.stringify({ challenge }), 'utf8').toString('base64url');
}

describe('passkey verify error branches', () => {
  let app: FastifyInstance;
  let sql: Sql;
  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  // ── register-verify ────────────────────────────────────────────────────

  it('register-verify: challenge that was never stored → 400 invalid or expired', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register-verify',
      payload: {
        response: {
          id: 'cred-never',
          rawId: 'cred-never',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: clientDataFor('challenge-never-stored') },
        },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid or expired challenge');
  });

  it('register-verify: stored challenge belongs to a DIFFERENT user → 400', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    // El challenge fue guardado para OTRO usuario (no el autenticado).
    const otherUser = await t.deps.users.create('other-passkey@example.test', 'local');
    expect(otherUser.id).not.toBe(t.userId);
    const challenge = 'challenge-other-user';
    await t.deps.passkeys!.saveChallenge(challenge, 'registration', otherUser.id);

    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register-verify',
      payload: {
        response: {
          id: 'cred-other',
          rawId: 'cred-other',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: clientDataFor(challenge) },
        },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid or expired challenge');
  });

  it('register-verify: gate 404 in local mode', async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/register-verify' });
    expect(r.statusCode).toBe(404);
  });

  it('register-verify: without identity → 401', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => null }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/register-verify',
      payload: {},
    });
    expect(r.statusCode).toBe(401);
  });

  // ── authenticate-options ───────────────────────────────────────────────

  it('authenticate-options: happy path returns options and stores the challenge', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/authenticate-options' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(typeof body.challenge).toBe('string');

    // El challenge de authentication quedó persistido (userId null), consumible.
    const taken = await t.deps.passkeys!.takeChallenge(body.challenge, 'authentication');
    expect(taken).not.toBeNull();
    expect(taken?.userId).toBeNull();
  });

  it('authenticate-options: gate 404 in local mode', async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/authenticate-options' });
    expect(r.statusCode).toBe(404);
  });

  // ── authenticate-verify ────────────────────────────────────────────────

  it('authenticate-verify: missing response body → 400', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/authenticate-verify',
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('response required');
  });

  it('authenticate-verify: challenge never stored → 400 invalid or expired', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/authenticate-verify',
      payload: {
        response: {
          id: 'cred-auth-never',
          rawId: 'cred-auth-never',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: clientDataFor('auth-challenge-never') },
        },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid or expired challenge');
  });

  it('authenticate-verify: valid challenge but unknown credentialId → 404', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    const challenge = 'auth-challenge-stored';
    await t.deps.passkeys!.saveChallenge(challenge, 'authentication', null);

    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/authenticate-verify',
      payload: {
        response: {
          id: 'cred-unknown',
          rawId: 'cred-unknown',
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: clientDataFor(challenge) },
        },
      },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('credential not registered');
  });

  it('authenticate-verify: gate 404 in local mode', async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    const r = await app.inject({ method: 'POST', url: '/api/auth/passkey/authenticate-verify' });
    expect(r.statusCode).toBe(404);
  });

  it('authenticate-verify: soft-disabled user (active=false) → 403 before crypto verify', async () => {
    const t = await buildTestApp();
    sql = t.sql;
    await t.app.close();
    app = await buildApp(serverDeps(t.deps, { resolve: async () => ({ kind: "user" as const, userId: t.userId }) }));

    // Register a passkey for the user, then disable the account.
    const credentialId = 'cred-disabled-user';
    await t.deps.passkeys!.register({
      userId: t.userId,
      credentialId,
      publicKey: Buffer.from('fake-key').toString('base64url'),
      counter: 0,
    });
    await t.deps.users.setActive(t.userId, false);

    const challenge = 'auth-challenge-disabled';
    await t.deps.passkeys!.saveChallenge(challenge, 'authentication', null);

    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/passkey/authenticate-verify',
      payload: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: 'public-key',
          clientExtensionResults: {},
          response: { clientDataJSON: clientDataFor(challenge) },
        },
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/disabled/i);
  });
});
