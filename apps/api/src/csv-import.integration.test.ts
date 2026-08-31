import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Integration tests del endpoint POST /api/admin/orgs/:orgId/users/import-csv.
 *
 * Cubrimos:
 *  - 403 cuando el caller no es admin de la org.
 *  - 400 sin body.csv / con body inválido.
 *  - 413 cuando el CSV pasa 2MB.
 *  - Dry-run: NO inserta, devuelve rows + errors para preview.
 *  - Apply: inserta + reporta created/updated counts.
 *  - Idempotencia: re-ejecutar el mismo CSV → 0 created, todos updated.
 *  - El user lookup post-import por email funciona.
 *  - Errores por-fila se reportan sin abortar el batch.
 */

describe('POST /api/admin/orgs/:orgId/users/import-csv', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: Awaited<ReturnType<typeof buildTestApp>>['deps'];
  let orgId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    deps = t.deps;
    orgId = t.defaultOrgId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('dry-run does NOT insert rows — returns preview only', async () => {
    const csv = `email,first_name,last_name
ana@x.com,Ana,Pérez
bob@x.com,Bob,Smith`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv, dryRun: true },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.applied).toBe(false);
    expect(body.rows).toHaveLength(2);
    expect(body.errors).toEqual([]);
    expect(body.separator).toBe(',');

    // Nadie en la DB todavía.
    expect(await deps.users.findByEmail('ana@x.com')).toBeNull();
    expect(await deps.users.findByEmail('bob@x.com')).toBeNull();
  });

  it('apply mode creates new users + reports counts', async () => {
    const csv = `email,first_name,last_name
ana@x.com,Ana,Pérez
bob@x.com,Bob,Smith`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.applied).toBe(true);
    expect(body.created).toBe(2);
    expect(body.updated).toBe(0);

    const ana = await deps.users.findByEmail('ana@x.com');
    expect(ana?.provider).toBe('csv_import');
    expect(ana?.firstName).toBe('Ana');
  });

  it('re-running the same CSV is idempotent — 0 created, N updated', async () => {
    const csv = `email,first_name,last_name
ana@x.com,Ana,Pérez`;
    await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv },
    });
    expect(r.json()).toMatchObject({ created: 0, updated: 1 });
  });

  it('per-row errors do NOT abort the batch — good rows still imported', async () => {
    // Mix de buenas y malas. El parser reporta las malas, pero las buenas
    // se aplican. Esto es lo que un admin esperaría: si solo 2 de 5 filas
    // tienen email malformado, no aborte todo.
    const csv = `email,first_name
ok1@x.com,A
bad-email,B
ok2@x.com,C
,D
ok3@x.com,E`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv },
    });
    const body = r.json();
    expect(body.applied).toBe(true);
    expect(body.created).toBe(3); // ok1, ok2, ok3
    expect(body.errors).toHaveLength(2); // bad-email + empty-email
    expect(await deps.users.findByEmail('ok2@x.com')).toBeTruthy();
    expect(await deps.users.findByEmail('bad-email')).toBeNull();
  });

  it('400 when body.csv is missing', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { dryRun: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/body.csv/);
  });

  it('400 when body.csv is not a string', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv: 42 },
    });
    expect(r.statusCode).toBe(400);
  });

  it('413 when CSV is too large (>2MB)', async () => {
    const bigCsv = 'email\n' + 'a@x.com\n'.repeat(300_000); // ~2.4MB
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv: bigCsv },
    });
    // Fastify defaults limit body to 1MB anyway, so this might return 413 from
    // the framework before we see it. Either 413 (our check) or 413 (framework)
    // — both signal "too large", which is what we want. We assert it's NOT
    // 200/4xx-misc.
    expect(r.statusCode).toBe(413);
  });

  it('member (non-admin) caller → 403', async () => {
    // A plain MEMBER of the org (not admin) gets 403 — they belong but lack the
    // role. (A non-member would get 404 instead; see the next test.)
    const u = await deps.users.create('member@x.com');
    await deps.organizations.addOrUpdateMember(orgId, u.id, 'org_member');
    const { SingleUserAuthProvider } = await import('@diluxite/core');
    const { buildApp } = await import('./app');
    const app2 = await buildApp({ ...deps, auth: new SingleUserAuthProvider(u.id) });
    await app2.ready();
    try {
      const r = await app2.inject({
        method: 'POST',
        url: `/api/admin/orgs/${orgId}/users/import-csv`,
        payload: { csv: 'email\nfoo@x.com' },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toMatch(/admin/);
    } finally {
      await app2.close();
    }
  });

  it('non-member caller → 404 (no existence leak)', async () => {
    // A user who is NOT a member of the org gets 404, unified with every other
    // org-scoped endpoint — we don't disclose the org's existence to outsiders.
    const u = await deps.users.create('outsider@x.com');
    const { SingleUserAuthProvider } = await import('@diluxite/core');
    const { buildApp } = await import('./app');
    const app2 = await buildApp({ ...deps, auth: new SingleUserAuthProvider(u.id) });
    await app2.ready();
    try {
      const r = await app2.inject({
        method: 'POST',
        url: `/api/admin/orgs/${orgId}/users/import-csv`,
        payload: { csv: 'email\nfoo@x.com' },
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await app2.close();
    }
  });

  it('rows include the original 1-based line number for the UI', async () => {
    const csv = `email,first_name
ana@x.com,A
bob@x.com,B`;
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv, dryRun: true },
    });
    expect(r.json().rows[0].line).toBe(2);
    expect(r.json().rows[1].line).toBe(3);
  });

  it('preserves provider when the user already existed with a different provider', async () => {
    // OIDC user came first; admin then imports a CSV including the same email
    // (typical "I want to add the manager name to the existing accounts").
    // We should patch first/last but NOT overwrite provider to 'csv_import'.
    await deps.users.createFromExternal({
      email: 'oidc@x.com',
      provider: 'oidc',
      firstName: 'Old',
      lastName: 'Name',
    });
    const csv = `email,first_name,last_name
oidc@x.com,NewFirst,NewLast`;
    await app.inject({
      method: 'POST',
      url: `/api/admin/orgs/${orgId}/users/import-csv`,
      payload: { csv },
    });
    const u = await deps.users.findByEmail('oidc@x.com');
    expect(u?.provider).toBe('oidc'); // preserved
    expect(u?.firstName).toBe('NewFirst');
    expect(u?.lastName).toBe('NewLast');
  });
});
