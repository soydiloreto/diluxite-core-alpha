import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { TrustedHeaderAuthProvider } from '@diluxite/core';
import { DrizzleOrgSettingsRepository, createDb } from '@diluxite/db';
import { buildApp } from './app';
import { buildTestApp } from '../test/helpers';

/**
 * Integration tests del TrustedHeader path contra DB real.
 *
 * Cubrimos el end-to-end: header llega → API resuelve identidad → 200 con
 * datos correctos. Y los caminos negativos: header ausente → 401, email
 * malformado → 401, user soft-disabled → 401, policy denies unknown →
 * 401.
 *
 * Estos complementan los unit tests del provider — acá probamos
 * concretamente la **integración con Fastify** y el preHandler, y que el
 * userId resuelto realmente llegue a la query de `/api/spaces`.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';
const HEADER = 'cf-access-authenticated-user-email';

interface Handles {
  app: FastifyInstance;
  sql: Sql;
  deps: Awaited<ReturnType<typeof buildTestApp>>['deps'];
  orgId: string;
  orgSettings: DrizzleOrgSettingsRepository;
}

async function boot(): Promise<Handles> {
  const t = await buildTestApp();
  const db = createDb(TEST_URL).db;
  const orgSettings = new DrizzleOrgSettingsRepository(db);
  const headerAuth = new TrustedHeaderAuthProvider(t.deps.users, {
    headerName: HEADER,
    getAuthPolicy: () => orgSettings.getAuthPolicy(t.defaultOrgId),
  });
  // Replace the SingleUserAuthProvider with our header-only one so the
  // test can drive identity by passing the header.
  await t.app.close();
  const app = await buildApp({ ...t.deps, auth: headerAuth });
  await app.ready();
  return { app, sql: t.sql, deps: t.deps, orgId: t.defaultOrgId, orgSettings };
}

describe('TrustedHeader — happy paths', () => {
  let h: Handles;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => {
    await h.app.close();
    await h.sql.end();
  });

  it('header con email VÁLIDO + policy default → JIT crea user y devuelve datos', async () => {
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'new@empresa.com' },
    });
    expect(r.statusCode).toBe(200);
    // El user fue creado con provider='trusted_header'.
    const u = await h.deps.users.findByEmail('new@empresa.com');
    expect(u).toBeTruthy();
    expect(u!.provider).toBe('trusted_header');
  });

  it('user EXISTING (csv_import o oidc) → header lo resuelve sin re-crear', async () => {
    await h.deps.users.upsertFromCsv({
      email: 'preloaded@x.com',
      firstName: 'Pre',
      lastName: 'Loaded',
    });
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'preloaded@x.com' },
    });
    expect(r.statusCode).toBe(200);
    const u = await h.deps.users.findByEmail('preloaded@x.com');
    expect(u!.provider).toBe('csv_import'); // provider NO se sobreescribe
  });

  it('updates last_login_at on every request through the header', async () => {
    await h.app.inject({ method: 'GET', url: '/api/spaces', headers: { [HEADER]: 'a@x.com' } });
    await h.app.inject({ method: 'GET', url: '/api/spaces', headers: { [HEADER]: 'a@x.com' } });
    const before = (await h.deps.users.findByEmail('a@x.com'))!.lastLoginAt;
    await new Promise((r) => setTimeout(r, 30));
    await h.app.inject({ method: 'GET', url: '/api/spaces', headers: { [HEADER]: 'a@x.com' } });
    const after = (await h.deps.users.findByEmail('a@x.com'))!.lastLoginAt;
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });
});

describe('TrustedHeader — negative paths return 401 (gate closes)', () => {
  let h: Handles;
  beforeEach(async () => { h = await boot(); });
  afterEach(async () => {
    await h.app.close();
    await h.sql.end();
  });

  it('NO header → 401 (delega y nadie autentica)', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/spaces' });
    expect(r.statusCode).toBe(401);
  });

  it('header con email malformado → 401', async () => {
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'not-an-email' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('user existente PERO active=false → 401', async () => {
    const u = await h.deps.users.create('banned@x.com');
    await h.deps.users.setActive(u.id, false);
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'banned@x.com' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('policy=deny_unknown + email desconocido → 401, user NO se crea', async () => {
    await h.orgSettings.setAuthPolicy(h.orgId, 'deny_unknown');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'ghost@x.com' },
    });
    expect(r.statusCode).toBe(401);
    expect(await h.deps.users.findByEmail('ghost@x.com')).toBeNull();
  });

  it('policy=pre_provisioned_only + email desconocido → 401', async () => {
    await h.orgSettings.setAuthPolicy(h.orgId, 'pre_provisioned_only');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'unknown@x.com' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('header name configurado distinto → solo respeta ESE header (no el default)', async () => {
    const db = createDb(TEST_URL).db;
    const headerAuth = new TrustedHeaderAuthProvider(h.deps.users, {
      headerName: 'x-authelia-email',
      getAuthPolicy: () => new DrizzleOrgSettingsRepository(db).getAuthPolicy(h.orgId),
    });
    await h.app.close();
    h.app = await buildApp({ ...h.deps, auth: headerAuth });
    await h.app.ready();
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: 'tries-default-header@x.com' },
    });
    expect(r.statusCode).toBe(401);
    expect(await h.deps.users.findByEmail('tries-default-header@x.com')).toBeNull();
  });
});
