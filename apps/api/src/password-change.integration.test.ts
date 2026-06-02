import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import {
  DrizzleAuditEventsRepository,
  DrizzleOrganizationsRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
  createDb,
} from '@diluxite/db';
import { SingleUserAuthProvider, hashPassword, verifyPassword } from '@diluxite/core';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Password-change endpoint.
 *
 * Cubrimos los caminos críticos:
 *  - 400 si missing fields / new < 8 chars / new === current.
 *  - 401 si current_password es wrong + audit auth.password.change_failed.
 *  - 200 OK persiste el nuevo password (verify directo contra DB).
 *  - El cookie current sobrevive; las otras sesiones quedan revocadas.
 *  - 404 en local mode.
 *  - 401 sin auth.
 *  - Audit auth.password.changed con metadata.otherSessionsRevoked.
 */

describe('POST /api/auth/password', () => {
  let sql: ReturnType<typeof postgres>;
  let usersRepo: DrizzleUsersRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  let auditRepo: DrizzleAuditEventsRepository;
  let userId: string;
  let email: string;
  const OLD = 'old-password-12345';
  const NEW = 'new-password-67890';

  beforeAll(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    usersRepo = new DrizzleUsersRepository(conn.db);
    sessionsRepo = new DrizzleSessionsRepository(conn.db);
    auditRepo = new DrizzleAuditEventsRepository(conn.db);
    // Apply migration 0014 defensively.
    await sql`
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS ip text,
        ADD COLUMN IF NOT EXISTS user_agent text,
        ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`;
  });

  beforeEach(async () => {
    await sql`TRUNCATE audit_events, sessions, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    email = `pw-${Date.now()}@x.test`;
    const passwordHash = hashPassword(OLD);
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, password_hash, active)
      VALUES (gen_random_uuid(), ${email}, ${passwordHash}, true)
      RETURNING id`;
    userId = r.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function buildAppFor(uid: string, opts?: { serverMode?: boolean }): Promise<FastifyInstance> {
    const conn = createDb(TEST_URL);
    const deps: AppDeps = {
      notes: {} as never,
      search: {} as never,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
      users: usersRepo,
      tokens: {} as never,
      sessions: opts?.serverMode === false ? undefined : sessionsRepo,
      tags: {} as never,
      links: {} as never,
      folders: {} as never,
      auth: new SingleUserAuthProvider(uid),
      info: {
        embedder: 'local',
        version: '0.0.0',
        authMode: opts?.serverMode === false ? 'local' : 'server',
      },
      audit: auditRepo,
    };
    const a = await buildApp(deps);
    await a.ready();
    return a;
  }

  it('returns 400 with missing fields', async () => {
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when new password is too short', async () => {
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: OLD, newPassword: 'short' }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/8/) });
    await app.close();
  });

  it('returns 400 when new equals current', async () => {
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: OLD, newPassword: OLD }),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/differ/) });
    await app.close();
  });

  it('returns 401 with wrong current password + records audit failure', async () => {
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: 'wrong', newPassword: NEW }),
    });
    expect(r.statusCode).toBe(401);
    const events = await auditRepo.list({ actorId: userId, actionPrefix: 'auth.password.change_failed' });
    expect(events).toHaveLength(1);
    await app.close();
  });

  it('200 on success — persists new hash + audit + invalidates OTHER sessions', async () => {
    // Two pre-existing sessions: one we'll keep (current), one we expect to be revoked.
    const { token: currentToken } = await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: {
        'content-type': 'application/json',
        cookie: `diluxite_session=${currentToken}`,
      },
      payload: JSON.stringify({ currentPassword: OLD, newPassword: NEW }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, otherSessionsRevoked: 1 });

    // DB has the new hash.
    const updated = await usersRepo.findWithPasswordByEmail(email);
    expect(updated).not.toBeNull();
    expect(verifyPassword(NEW, updated!.passwordHash!)).toBe(true);
    expect(verifyPassword(OLD, updated!.passwordHash!)).toBe(false);

    // The current cookie's session is still alive; the other is gone.
    const remaining = await sessionsRepo.listActiveForUser(userId, currentToken);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].current).toBe(true);

    const events = await auditRepo.list({ actorId: userId, actionPrefix: 'auth.password.changed' });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ otherSessionsRevoked: 1 });
    await app.close();
  });

  it('without cookie revokes ALL sessions of the user', async () => {
    await sessionsRepo.createSession(userId, 3600);
    await sessionsRepo.createSession(userId, 3600);
    const app = await buildAppFor(userId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: OLD, newPassword: NEW }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ otherSessionsRevoked: 2 });
    expect(await sessionsRepo.listActiveForUser(userId, null)).toHaveLength(0);
    await app.close();
  });

  it('404 in local mode', async () => {
    const app = await buildAppFor(userId, { serverMode: false });
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ currentPassword: OLD, newPassword: NEW }),
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
