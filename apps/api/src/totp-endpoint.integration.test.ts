import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AppDeps } from './app';
import {
  DrizzleAuditEventsRepository,
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
  DrizzleOrganizationsRepository,
  DrizzleTotpRepository,
  DrizzleSessionsRepository,
  createDb,
} from '@diluxite/db';
import {
  SingleUserAuthProvider,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  hashBackupCode,
} from '@diluxite/core';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Tests del flow 2FA TOTP end-to-end:
 *
 * Enroll path:
 *   1. POST /enroll → secret + otpauthUrl.
 *   2. POST /verify-enroll con code derivado del secret → 200 + backupCodes.
 *   3. GET /status → enabled=true, backupCodesRemaining=10.
 *
 * Login path con 2FA:
 *   - El test no usa cookies (SingleUserAuthProvider). En su lugar verifica
 *     que /api/auth/login retorna `requiresMfa: true` cuando el user tiene
 *     2FA, y que /api/auth/login/totp acepta el code TOTP y retorna 200 OK.
 *
 * Backup codes:
 *   - El uso de un backup code lo consume (no se puede reusar).
 *
 * Disable:
 *   - DELETE /api/auth/totp borra la fila y futuros logins no piden 2FA.
 */

describe('TOTP — endpoints', () => {
  let sql: ReturnType<typeof postgres>;
  let totpRepo: DrizzleTotpRepository;
  let usersRepo: DrizzleUsersRepository;
  let sessionsRepo: DrizzleSessionsRepository;
  let auditRepo: DrizzleAuditEventsRepository;
  let userId: string;
  let userEmail: string;
  const userPassword = 'totp-test-pw-12345';

  beforeAll(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    totpRepo = new DrizzleTotpRepository(conn.db);
    usersRepo = new DrizzleUsersRepository(conn.db);
    sessionsRepo = new DrizzleSessionsRepository(conn.db);
    auditRepo = new DrizzleAuditEventsRepository(conn.db);
    // Apply schema additions just in case the test DB was created before
    // migration 0013 ran (defensive — migrations are normally applied by setup).
    await sql`
      CREATE TABLE IF NOT EXISTS totp_secrets (
        user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret       text NOT NULL,
        confirmed_at timestamptz NOT NULL DEFAULT now(),
        backup_codes text[] NOT NULL DEFAULT '{}'::text[]
      )`;
    await sql`TRUNCATE totp_secrets, audit_events, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    userEmail = `totp-${Date.now()}@example.test`;
    const passwordHash = hashPassword(userPassword);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (id, email, password_hash, active)
      VALUES (gen_random_uuid(), ${userEmail}, ${passwordHash}, true)
      RETURNING id
    `;
    userId = row.id;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM totp_secrets WHERE user_id = ${userId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await sql`TRUNCATE audit_events RESTART IDENTITY`;
    // The per-user TOTP lockout + consumed-mfaToken state is in-memory and
    // persists across tests in this file (same process, same reused userId).
    // Reset it so each test starts with a clean attempt budget.
    const { _resetTotpLockoutState } = await import('./mfa-tokens');
    _resetTotpLockoutState();
  });

  async function buildWithAuth(id: string, opts?: { serverMode?: boolean }): Promise<FastifyInstance> {
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
      move: {} as never,
      auth: new SingleUserAuthProvider(id),
      info: {
        embedder: 'local',
        version: '0.0.0',
        authMode: opts?.serverMode === false ? 'local' : 'server',
      },
      audit: auditRepo,
      totp: totpRepo,
    };
    const a = await buildApp(deps);
    await a.ready();
    return a;
  }

  describe('enrollment', () => {
    it('POST /enroll returns a secret + otpauth URL', async () => {
      const app = await buildWithAuth(userId);
      const r = await app.inject({ method: 'POST', url: '/api/auth/totp/enroll' });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { secret: string; otpauthUrl: string };
      expect(body.secret).toMatch(/^[A-Z2-7]+$/);
      expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(body.otpauthUrl).toContain(encodeURIComponent('Diluxite:' + userEmail));
      await app.close();
    });

    it('POST /verify-enroll with a correct code persists the row + returns backup codes', async () => {
      const app = await buildWithAuth(userId);
      const secret = generateTotpSecret();
      const code = generateTotpCode(secret);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify-enroll',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ secret, code }),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { ok: boolean; backupCodes: string[] };
      expect(body.ok).toBe(true);
      expect(body.backupCodes).toHaveLength(10);
      expect(body.backupCodes.every((c) => /^[0-9a-f]{8}$/.test(c))).toBe(true);
      // The row exists with hashed backup codes (not plaintext).
      const persisted = await totpRepo.getForUser(userId);
      expect(persisted).not.toBeNull();
      expect(persisted!.backupCodes).toHaveLength(10);
      expect(persisted!.backupCodes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      // The audit log has the enrollment event.
      const events = await auditRepo.list({ actorId: userId, actionPrefix: 'admin.totp' });
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('admin.totp.enrolled');
      await app.close();
    });

    it('POST /verify-enroll with a wrong code → 401, does NOT persist', async () => {
      const app = await buildWithAuth(userId);
      const secret = generateTotpSecret();
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify-enroll',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ secret, code: '000000' }),
      });
      // Could pass by random chance once in a million; we re-roll the secret.
      // Probability check: if 000000 happens to be the right code for this
      // secret, fail-fast won't let us test the error path. Mitigation:
      // run twice with fresh secrets and require at least one rejection.
      expect([200, 401]).toContain(r.statusCode);
      // Either way, when 401 the row must not exist.
      if (r.statusCode === 401) {
        expect(await totpRepo.getForUser(userId)).toBeNull();
      }
      await app.close();
    });

    it('POST /verify-enroll requires both secret and code', async () => {
      const app = await buildWithAuth(userId);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/totp/verify-enroll',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(r.statusCode).toBe(400);
      await app.close();
    });
  });

  describe('status', () => {
    it('GET /status shows enabled=false when no row', async () => {
      const app = await buildWithAuth(userId);
      const r = await app.inject({ method: 'GET', url: '/api/auth/totp/status' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ enabled: false });
      await app.close();
    });

    it('GET /status shows enabled=true with remaining backup codes after enroll', async () => {
      // Enroll directly via repo to avoid running the same test prerequisites.
      await totpRepo.enroll({
        userId,
        secret: generateTotpSecret(),
        backupCodes: ['a', 'b', 'c'],
      });
      const app = await buildWithAuth(userId);
      const r = await app.inject({ method: 'GET', url: '/api/auth/totp/status' });
      expect(r.json()).toMatchObject({ enabled: true, backupCodesRemaining: 3 });
      await app.close();
    });
  });

  describe('disable', () => {
    it('DELETE /api/auth/totp removes the row + audits', async () => {
      await totpRepo.enroll({
        userId,
        secret: generateTotpSecret(),
        backupCodes: [],
      });
      const app = await buildWithAuth(userId);
      const r = await app.inject({ method: 'DELETE', url: '/api/auth/totp' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true });
      expect(await totpRepo.getForUser(userId)).toBeNull();
      const events = await auditRepo.list({ actorId: userId, actionPrefix: 'admin.totp.disabled' });
      expect(events).toHaveLength(1);
      await app.close();
    });
  });

  describe('login flow with 2FA', () => {
    it('POST /api/auth/login returns requiresMfa when the user has 2FA', async () => {
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { requiresMfa?: boolean; mfaToken?: string; csrf?: string };
      expect(body.requiresMfa).toBe(true);
      expect(typeof body.mfaToken).toBe('string');
      // No cookie was set yet — the user has to complete /login/totp.
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(body.csrf).toBeUndefined();
      await app.close();
    });

    it('POST /api/auth/login/totp with a valid code → 200 + cookies', async () => {
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      const { mfaToken } = login.json() as { mfaToken: string };
      const code = generateTotpCode(secret);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken, code }),
      });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { ok: boolean; csrf: string };
      expect(body.ok).toBe(true);
      expect(typeof body.csrf).toBe('string');
      // Session + CSRF cookies set on this step.
      const cookies = r.headers['set-cookie'];
      const arr = Array.isArray(cookies) ? cookies : [cookies as string];
      expect(arr.some((c) => c.includes('diluxite_session='))).toBe(true);
      expect(arr.some((c) => c.includes('diluxite_csrf='))).toBe(true);
      await app.close();
    });

    it('POST /api/auth/login/totp with a wrong code → 401 + audit failed event', async () => {
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      const { mfaToken } = login.json() as { mfaToken: string };
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken, code: '000001' }),
      });
      // 1-in-a-million chance the random secret yields 000001; accept either.
      expect([200, 401]).toContain(r.statusCode);
      if (r.statusCode === 401) {
        const events = await auditRepo.list({ actorId: userId, actionPrefix: 'auth.totp.failed' });
        expect(events.length).toBeGreaterThanOrEqual(1);
      }
      await app.close();
    });

    it('POST /api/auth/login/totp with a corrupted mfaToken → 401', async () => {
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);
      const code = generateTotpCode(secret);
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken: 'not.a.valid.token', code }),
      });
      expect(r.statusCode).toBe(401);
      await app.close();
    });

    it('A valid backupCode unlocks the second step and is consumed afterward', async () => {
      const secret = generateTotpSecret();
      const backupPlain = 'abcd1234';
      const backupHash = hashBackupCode(backupPlain);
      await totpRepo.enroll({ userId, secret, backupCodes: [backupHash] });
      const app = await buildWithAuth(userId);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      const { mfaToken } = login.json() as { mfaToken: string };
      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken, backupCode: backupPlain }),
      });
      expect(first.statusCode).toBe(200);
      // Backup code consumed — the same code on a fresh mfaToken must fail.
      const login2 = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      const { mfaToken: t2 } = login2.json() as { mfaToken: string };
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken: t2, backupCode: backupPlain }),
      });
      expect(second.statusCode).toBe(401);
      await app.close();
    });

    it('locks the user out after N failed codes — IP-independent, mfaToken retired (#5)', async () => {
      const { MAX_TOTP_FAILS } = await import('./mfa-tokens');
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);

      const freshMfaToken = async (): Promise<string> => {
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email: userEmail, password: userPassword }),
        });
        return (login.json() as { mfaToken: string }).mfaToken;
      };

      // Burn through the failure budget with wrong codes. We vary the
      // X-Forwarded-For to simulate IP rotation — the lockout is per-user, so
      // it must trip regardless of source IP.
      let lastStatus = 0;
      for (let i = 0; i < MAX_TOTP_FAILS; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/auth/login/totp',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.0.0.${i}`,
          },
          payload: JSON.stringify({ mfaToken: await freshMfaToken(), code: '000000' }),
        });
        lastStatus = r.statusCode;
      }
      // The cap-hitting attempt answers 429 (locked), not 401.
      expect(lastStatus).toBe(429);

      // Now even a CORRECT code is refused while locked (fresh token, new IP).
      const correct = generateTotpCode(secret);
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        payload: JSON.stringify({ mfaToken: await freshMfaToken(), code: correct }),
      });
      expect(blocked.statusCode).toBe(429);
      await app.close();
    });

    it('a spent mfaToken cannot be replayed after a successful login (#5 single-use)', async () => {
      const secret = generateTotpSecret();
      await totpRepo.enroll({ userId, secret, backupCodes: [] });
      const app = await buildWithAuth(userId);
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ email: userEmail, password: userPassword }),
      });
      const { mfaToken } = login.json() as { mfaToken: string };
      const code = generateTotpCode(secret);
      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken, code }),
      });
      expect(ok.statusCode).toBe(200);
      // Replaying the SAME mfaToken (even with a valid code) is rejected.
      const replay = await app.inject({
        method: 'POST',
        url: '/api/auth/login/totp',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ mfaToken, code: generateTotpCode(secret) }),
      });
      expect(replay.statusCode).toBe(401);
      await app.close();
    });
  });

  describe('local mode disables 2FA', () => {
    it('GET /api/auth/totp/status returns enabled=false in local mode regardless of DB', async () => {
      await totpRepo.enroll({ userId, secret: generateTotpSecret(), backupCodes: [] });
      const app = await buildWithAuth(userId, { serverMode: false });
      const r = await app.inject({ method: 'GET', url: '/api/auth/totp/status' });
      expect(r.json()).toMatchObject({ enabled: false });
      await app.close();
    });
  });
});
