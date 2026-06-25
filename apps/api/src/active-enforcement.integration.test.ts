import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './app';
import {
  DrizzleOrganizationsRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
  DrizzleTokensRepository,
  createDb,
} from '@diluxite/db';
import { SessionAuthProvider, hashPassword } from '@diluxite/core';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Soft-disable (active=false) enforcement across the three credential paths:
 *   1. Password login → 403 (after the password check, so we don't leak which
 *      emails are disabled).
 *   2. An EXISTING session of a user the admin just disabled stops resolving
 *      identity on the next request (DrizzleSessionsRepository joins users and
 *      filters active=true).
 *
 * Passkey-verify's active gate lives in passkey-verify.integration.test.ts.
 */
describe('active=false enforcement (password + session)', () => {
  let sql: ReturnType<typeof postgres>;
  let usersRepo: DrizzleUsersRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  let tokensRepo: DrizzleTokensRepository;
  let conn: ReturnType<typeof createDb>;
  let userId: string;
  let email: string;
  const PW = 'correct-horse-battery';

  beforeAll(() => {
    conn = createDb(TEST_URL);
    sql = conn.sql;
    usersRepo = new DrizzleUsersRepository(conn.db);
    sessionsRepo = new DrizzleSessionsRepository(conn.db);
    tokensRepo = new DrizzleTokensRepository(conn.db);
  });

  beforeEach(async () => {
    await sql`TRUNCATE audit_events, sessions, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    email = `active-${Date.now()}@x.test`;
    const [r] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, password_hash, active)
      VALUES (gen_random_uuid(), ${email}, ${hashPassword(PW)}, true)
      RETURNING id`;
    userId = r.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  function buildServerApp(): Promise<FastifyInstance> {
    const deps: AppDeps = {
      notes: {} as never,
      search: {} as never,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
      users: usersRepo,
      tokens: tokensRepo,
      sessions: sessionsRepo,
      tags: {} as never,
      links: {} as never,
      folders: {} as never,
      move: {} as never,
      auth: new SessionAuthProvider(sessionsRepo, tokensRepo),
      info: { embedder: 'local', version: '0.0.0', authMode: 'server' },
    };
    return buildApp(deps).then(async (a) => {
      await a.ready();
      return a;
    });
  }

  it('password login on a disabled account → 403 (even with the right password)', async () => {
    await usersRepo.setActive(userId, false);
    const app = await buildServerApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PW },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/disabled/i);
    await app.close();
  });

  it('password login still works while active=true (sanity, no regression)', async () => {
    const app = await buildServerApp();
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PW },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    await app.close();
  });

  it('an existing session stops resolving identity once the user is disabled', async () => {
    // Mint a session while active, confirm it resolves, then disable + recheck.
    const { token } = await sessionsRepo.createSession(userId);
    expect(await sessionsRepo.findUserIdBySession(token)).toBe(userId);

    await usersRepo.setActive(userId, false);
    expect(await sessionsRepo.findUserIdBySession(token)).toBeNull();

    // And end-to-end: a request carrying that cookie is now 401 at the API gate.
    const app = await buildServerApp();
    const r = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { cookie: `diluxite_session=${token}` },
    });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  // #11a — a personal Bearer token must stop working when its owner is disabled.
  it('a user Bearer token stops resolving once the owner is disabled', async () => {
    const { token } = await tokensRepo.create(userId, 'api');
    const app = await buildServerApp();
    // While active → authenticated (200; empty spaces list is fine).
    const ok = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);

    await usersRepo.setActive(userId, false);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });
});
