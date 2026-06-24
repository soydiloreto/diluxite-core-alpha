import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import { DrizzleAuditEventsRepository, createDb } from '@diluxite/db';
import { SingleUserAuthProvider } from '@diluxite/core';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * End-to-end del audit log via la API:
 *
 *  1. GET /api/admin/orgs/:orgId/audit retorna eventos creados directamente en DB.
 *  2. Filtros action / actorId / from / to / beforeId / limit pasan correctamente.
 *  3. Validación de input (date raro, beforeId no-int) → 400 friendly.
 *  4. Member ve solo sus eventos (forced restriction al server side).
 *  5. Admin ve todo el scope del org.
 *  6. 404 si el caller no es miembro de la org.
 *  7. 404 si no hay audit repo wired (deps.audit ausente).
 *
 * No instala bootstrap de server-mode; usamos SingleUserAuthProvider con un
 * userId fijo, lo cual nos da `req.identity.userId = <ese id>` en todas las
 * requests sin pelearnos con cookies / sesiones. La "ver solo lo mío" la
 * verificamos con dos members distintos via el filtro role.
 */

describe('audit endpoint — GET /api/admin/orgs/:orgId/audit', () => {
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let auditRepo: DrizzleAuditEventsRepository;
  let orgId: string;
  let adminUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    auditRepo = new DrizzleAuditEventsRepository(conn.db);

    // Limpio tablas relevantes. Truncate cascade asegura que no quedan
    // refs colgando entre runs (los integration tests comparten DB).
    await sql`TRUNCATE audit_events, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;

    // Setup mínimo: una org con un admin y un member.
    [adminUserId] = (
      await sql<{ id: string }[]>`
        INSERT INTO users (id, email, active)
        VALUES (gen_random_uuid(), 'admin@audit.test', true)
        RETURNING id
      `
    ).map((r) => r.id);
    [memberUserId] = (
      await sql<{ id: string }[]>`
        INSERT INTO users (id, email, active)
        VALUES (gen_random_uuid(), 'member@audit.test', true)
        RETURNING id
      `
    ).map((r) => r.id);
    [orgId] = (
      await sql<{ id: string }[]>`
        INSERT INTO organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Audit Org', 'audit-org')
        RETURNING id
      `
    ).map((r) => r.id);
    await sql`INSERT INTO org_memberships (org_id, user_id, role) VALUES (${orgId}, ${adminUserId}, 'admin')`;
    await sql`INSERT INTO org_memberships (org_id, user_id, role) VALUES (${orgId}, ${memberUserId}, 'member')`;
  });

  afterAll(async () => {
    if (app) await app.close();
    await sql.end();
  });

  async function buildWithUser(userId: string, withAudit = true): Promise<FastifyInstance> {
    const conn = createDb(TEST_URL);
    const { DrizzleSpacesRepository, DrizzleOrganizationsRepository, DrizzleUsersRepository } =
      await import('@diluxite/db');
    const deps: AppDeps = {
      notes: {} as never,
      search: {} as never,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
      users: new DrizzleUsersRepository(conn.db),
      tokens: {} as never,
      tags: {} as never,
      links: {} as never,
      folders: {} as never,
      move: {} as never,
      auth: new SingleUserAuthProvider(userId),
      info: { embedder: 'local', version: '0.0.0', authMode: 'local' },
      audit: withAudit ? auditRepo : undefined,
    };
    const a = await buildApp(deps);
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    // Wipe audit table between tests; users + org are stable for the file.
    await sql`TRUNCATE audit_events RESTART IDENTITY`;
  });

  it('returns events for the org (admin sees everything)', async () => {
    await auditRepo.record({
      orgId,
      actorId: memberUserId,
      action: 'auth.login.success',
    });
    await auditRepo.record({
      orgId,
      actorId: adminUserId,
      action: 'admin.users.csv_imported',
      metadata: { created: 3 },
    });
    app = await buildWithUser(adminUserId);
    const r = await app.inject({ method: 'GET', url: `/api/admin/orgs/${orgId}/audit` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { events: { action: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.events.map((e) => e.action).sort()).toEqual([
      'admin.users.csv_imported',
      'auth.login.success',
    ]);
    await app.close();
  });

  it('member sees ONLY their own events (server-side restriction)', async () => {
    await auditRepo.record({ orgId, actorId: memberUserId, action: 'auth.login.success' });
    await auditRepo.record({ orgId, actorId: adminUserId, action: 'auth.login.success' });
    app = await buildWithUser(memberUserId);
    const r = await app.inject({ method: 'GET', url: `/api/admin/orgs/${orgId}/audit` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { events: { actorId: string }[]; total: number };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].actorId).toBe(memberUserId);
    expect(body.total).toBe(1);
    await app.close();
  });

  it('member CANNOT see other members events even by passing actorId in query', async () => {
    await auditRepo.record({ orgId, actorId: adminUserId, action: 'auth.login.success' });
    app = await buildWithUser(memberUserId);
    const r = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?actorId=${adminUserId}`,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { events: unknown[]; total: number };
    // The server overrides the query.actorId with the caller's own — no leak.
    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
    await app.close();
  });

  it('filters by action prefix', async () => {
    await auditRepo.record({ orgId, actorId: adminUserId, action: 'auth.login.success' });
    await auditRepo.record({ orgId, actorId: adminUserId, action: 'auth.logout' });
    await auditRepo.record({ orgId, actorId: adminUserId, action: 'admin.token.minted' });
    app = await buildWithUser(adminUserId);
    const r = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?action=auth.`,
    });
    const body = r.json() as { events: { action: string }[] };
    expect(body.events.every((e) => e.action.startsWith('auth.'))).toBe(true);
    expect(body.events).toHaveLength(2);
    await app.close();
  });

  it('returns 400 for malformed `from` date', async () => {
    app = await buildWithUser(adminUserId);
    const r = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?from=not-a-date`,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/from/i) });
    await app.close();
  });

  it('returns 400 for non-numeric beforeId', async () => {
    app = await buildWithUser(adminUserId);
    const r = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?beforeId=abc`,
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 when caller is not a member of the org', async () => {
    const [outsiderId] = (
      await sql<{ id: string }[]>`
        INSERT INTO users (id, email, active)
        VALUES (gen_random_uuid(), 'outsider@audit.test', true)
        RETURNING id
      `
    ).map((r) => r.id);
    app = await buildWithUser(outsiderId);
    const r = await app.inject({ method: 'GET', url: `/api/admin/orgs/${orgId}/audit` });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 when audit repo is not configured', async () => {
    app = await buildWithUser(adminUserId, /* withAudit */ false);
    const r = await app.inject({ method: 'GET', url: `/api/admin/orgs/${orgId}/audit` });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/audit/i) });
    await app.close();
  });

  it('paginates via beforeId (cursor)', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      await auditRepo.record({ orgId, actorId: adminUserId, action: `e.${i}` });
    }
    // Read all to know the ids.
    const all = await auditRepo.list({ orgId });
    expect(all).toHaveLength(5);

    app = await buildWithUser(adminUserId);
    const r1 = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?limit=2`,
    });
    const body1 = r1.json() as { events: { id: number }[]; total: number };
    expect(body1.events).toHaveLength(2);
    expect(body1.total).toBe(5);

    const cursor = body1.events[1].id;
    const r2 = await app.inject({
      method: 'GET',
      url: `/api/admin/orgs/${orgId}/audit?limit=2&beforeId=${cursor}`,
    });
    const body2 = r2.json() as { events: { id: number }[] };
    expect(body2.events).toHaveLength(2);
    expect(body2.events.every((e) => e.id < cursor)).toBe(true);
    // No overlap between pages.
    const seen = new Set(body1.events.map((e) => e.id));
    expect(body2.events.every((e) => !seen.has(e.id))).toBe(true);
    await app.close();
  });
});
