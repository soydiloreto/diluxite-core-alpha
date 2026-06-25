import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import {
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
  DrizzleOrganizationsRepository,
  createDb,
} from '@diluxite/db';
import { SingleUserAuthProvider } from '@diluxite/core';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Active sessions endpoints.
 *
 *  GET /api/auth/sessions               → list (con current marker)
 *  DELETE /api/auth/sessions/:id        → revoke one
 *  POST /api/auth/sessions/revoke-others → revoke all except current
 *
 * Probamos:
 *  - GET retorna las sessions activas del user + ignora las de otros users.
 *  - GET marca `current: true` cuando viene con cookie diluxite_session
 *    matching.
 *  - DELETE :id borra solo si pertenece al user (defense in depth).
 *  - DELETE :id 404 cuando el session id no es del user.
 *  - POST revoke-others borra todas menos la current.
 *  - Audit events recordeados (admin.session.revoked / revoked_all_others).
 *  - Endpoints 404 en local mode.
 *  - Endpoints 401 sin auth.
 */

describe('sessions endpoints — list / revoke / revoke-others', () => {
  let sql: ReturnType<typeof postgres>;
  let sessionsRepo: DrizzleSessionsRepository;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    sessionsRepo = new DrizzleSessionsRepository(conn.db);
    // Apply migration 0014 defensively in case test DB predates it.
    await sql`
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS ip text,
        ADD COLUMN IF NOT EXISTS user_agent text,
        ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`;
    await sql`TRUNCATE audit_events, sessions, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const e1 = `s-user-${Date.now()}@x.test`;
    const e2 = `s-other-${Date.now()}@x.test`;
    const [u1] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, active) VALUES (gen_random_uuid(), ${e1}, true) RETURNING id`;
    userId = u1.id;
    const [u2] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, active) VALUES (gen_random_uuid(), ${e2}, true) RETURNING id`;
    otherUserId = u2.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function buildAppWithUser(uid: string, serverMode = true): Promise<FastifyInstance> {
    const conn = createDb(TEST_URL);
    const { DrizzleAuditEventsRepository } = await import('@diluxite/db');
    const deps: AppDeps = {
      notes: {} as never,
      search: {} as never,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
      users: new DrizzleUsersRepository(conn.db),
      tokens: {} as never,
      sessions: serverMode ? sessionsRepo : undefined,
      tags: {} as never,
      links: {} as never,
      folders: {} as never,
      move: {} as never,
      auth: new SingleUserAuthProvider(uid),
      info: {
        embedder: 'local',
        version: '0.0.0',
        authMode: serverMode ? 'server' : 'local',
      },
      audit: new DrizzleAuditEventsRepository(conn.db),
    };
    const a = await buildApp(deps);
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    await sql`DELETE FROM sessions`;
    await sql`TRUNCATE audit_events RESTART IDENTITY`;
  });

  it('GET /sessions lists only the caller\'s active sessions', async () => {
    await sessionsRepo.createSession(userId, 3600, { ip: '1.1.1.1', userAgent: 'A' });
    await sessionsRepo.createSession(userId, 3600, { ip: '2.2.2.2', userAgent: 'B' });
    await sessionsRepo.createSession(otherUserId, 3600, { ip: '9.9.9.9', userAgent: 'C' });
    const app = await buildAppWithUser(userId);
    const r = await app.inject({ method: 'GET', url: '/api/auth/sessions' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { sessions: { ip: string; userAgent: string; current: boolean }[] };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.every((s) => ['1.1.1.1', '2.2.2.2'].includes(s.ip))).toBe(true);
    expect(body.sessions.every((s) => s.current === false)).toBe(true);
    await app.close();
  });

  it('GET /sessions marks the row matching the cookie as current:true', async () => {
    const { token } = await sessionsRepo.createSession(userId, 3600, {
      ip: '1.1.1.1',
      userAgent: 'A',
    });
    await sessionsRepo.createSession(userId, 3600);
    const app = await buildAppWithUser(userId);
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { cookie: `diluxite_session=${token}` },
    });
    const body = r.json() as { sessions: { ip: string; current: boolean }[] };
    const current = body.sessions.find((s) => s.current);
    expect(current).toBeDefined();
    expect(current!.ip).toBe('1.1.1.1');
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
    await app.close();
  });

  it('DELETE /sessions/:id revokes if it belongs to the caller', async () => {
    const { token } = await sessionsRepo.createSession(userId, 3600);
    // Find the id.
    const list = await sessionsRepo.listActiveForUser(userId, token);
    const sessionId = list[0].id;
    const app = await buildAppWithUser(userId);
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${sessionId}`,
    });
    expect(r.statusCode).toBe(200);
    expect(await sessionsRepo.listActiveForUser(userId, null)).toHaveLength(0);
    await app.close();
  });

  it('DELETE /sessions/:id returns 404 when the id belongs to ANOTHER user', async () => {
    await sessionsRepo.createSession(otherUserId, 3600);
    const otherList = await sessionsRepo.listActiveForUser(otherUserId, null);
    const otherSessionId = otherList[0].id;
    const app = await buildAppWithUser(userId);
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${otherSessionId}`,
    });
    expect(r.statusCode).toBe(404);
    // The other user's session is still alive.
    expect(await sessionsRepo.listActiveForUser(otherUserId, null)).toHaveLength(1);
    await app.close();
  });

  it('POST /sessions/revoke-others kills every session except the current cookie', async () => {
    const { token: currentToken } = await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    expect(await sessionsRepo.listActiveForUser(userId, null)).toHaveLength(3);
    const app = await buildAppWithUser(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-others',
      headers: { cookie: `diluxite_session=${currentToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ revoked: 2 });
    const remaining = await sessionsRepo.listActiveForUser(userId, currentToken);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].current).toBe(true);
    await app.close();
  });

  it('POST /sessions/revoke-others without cookie kills ALL sessions', async () => {
    await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    const app = await buildAppWithUser(userId);
    const r = await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-others' });
    expect(r.json()).toMatchObject({ revoked: 2 });
    expect(await sessionsRepo.listActiveForUser(userId, null)).toHaveLength(0);
    await app.close();
  });

  it('all endpoints return 404 in local mode', async () => {
    const app = await buildAppWithUser(userId, false);
    expect((await app.inject({ method: 'GET', url: '/api/auth/sessions' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/auth/sessions/abc' })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-others' })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it('audits admin.session.revoked + admin.session.revoked_all_others', async () => {
    const { token: cur } = await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    const list = await sessionsRepo.listActiveForUser(userId, cur);
    const targetId = list.find((s) => !s.current)!.id;
    const app = await buildAppWithUser(userId);
    await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${targetId}`,
      headers: { cookie: `diluxite_session=${cur}` },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/sessions/revoke-others',
      headers: { cookie: `diluxite_session=${cur}` },
    });
    const conn = createDb(TEST_URL);
    const { DrizzleAuditEventsRepository } = await import('@diluxite/db');
    const audit = new DrizzleAuditEventsRepository(conn.db);
    const events = await audit.list({ actorId: userId, actionPrefix: 'admin.session.' });
    const actions = events.map((e) => e.action).sort();
    expect(actions).toContain('admin.session.revoked');
    expect(actions).toContain('admin.session.revoked_all_others');
    await app.close();
  });
});
