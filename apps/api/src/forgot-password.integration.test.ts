import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  DeterministicEmbeddingProvider,
  NoopEmailProvider,
  NotesService,
  SearchService,
  SessionAuthProvider,
  hashPassword,
  verifyPassword,
  type EmailMessage,
  type EmailProvider,
} from '@diluxite/core';
import {
  createDb,
  DrizzleAuditEventsRepository,
  DrizzleFoldersRepository,
  DrizzleLinksRepository,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzlePasswordResetsRepository,
  DrizzleSearchRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { buildApp } from '../src/app';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * Spy email provider: captures sends in a list so tests can assert on the
 * link, subject, etc. NEVER sends — local tests run without SMTP.
 */
class SpyEmailProvider implements EmailProvider {
  readonly name = 'spy';
  readonly sent: EmailMessage[] = [];
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m);
  }
}

async function bootstrap() {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, organizations, sessions, password_resets, users RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const conn = createDb(TEST_DATABASE_URL);
  const { sql, db } = conn;

  const users = new DrizzleUsersRepository(db);
  const sessions = new DrizzleSessionsRepository(db);
  const passwordResets = new DrizzlePasswordResetsRepository(db);
  const audit = new DrizzleAuditEventsRepository(db);
  const organizations = new DrizzleOrganizationsRepository(db);
  const spaces = new DrizzleSpacesRepository(db);

  // Seed a user with a known password.
  const user = await users.create('alice@diluxite.test');
  await users.setPassword(user.id, hashPassword('original-pass-123'));

  const notesRepo = new DrizzleNotesRepository(db);
  const search = new SearchService(
    new DrizzleSearchRepository(db),
    new DeterministicEmbeddingProvider(1536),
    notesRepo,
  );
  const notes = new NotesService(notesRepo, search);
  const tokens = new DrizzleTokensRepository(db);
  const auth = new SessionAuthProvider(sessions, tokens);
  const email = new SpyEmailProvider();

  const app = await buildApp({
    notes,
    search,
    spaces,
    organizations,
    users,
    tokens,
    sessions,
    tags: new DrizzleTagsRepository(db),
    links: new DrizzleLinksRepository(db),
    folders: new DrizzleFoldersRepository(db),
    auth,
    info: { embedder: 'deterministic', version: 'test', authMode: 'server' },
    audit,
    email,
    passwordResets,
    publicWebUrl: 'https://test.diluxite.local',
  });
  await app.ready();
  return { app, sql, db, users, user, sessions, passwordResets, audit, email };
}

describe('Forgot password — /api/auth/forgot', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let ctx: Awaited<ReturnType<typeof bootstrap>>;

  beforeEach(async () => {
    ctx = await bootstrap();
    app = ctx.app;
    sql = ctx.sql;
  });
  afterEach(async () => {
    await app?.close();
    await sql?.end();
  });

  it('returns 200 + sends the reset email when the user exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'alice@diluxite.test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(ctx.email.sent).toHaveLength(1);
    const msg = ctx.email.sent[0];
    expect(msg.to).toBe('alice@diluxite.test');
    expect(msg.subject).toMatch(/reset/i);
    // The reset link uses publicWebUrl + ?token=... — token in the email
    // is the plain value, NOT the hash (the hash is what we store).
    expect(msg.text).toMatch(/https:\/\/test\.diluxite\.local\/reset\?token=/);
  });

  it('ignores a malicious Origin header — the link uses publicWebUrl, not evil.com', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      headers: { origin: 'https://evil.com' },
      payload: { email: 'alice@diluxite.test' },
    });
    expect(res.statusCode).toBe(200);
    const msg = ctx.email.sent[0];
    expect(msg.text).toMatch(/https:\/\/test\.diluxite\.local\/reset\?token=/);
    expect(msg.text).not.toMatch(/evil\.com/);
    expect(msg.html).not.toMatch(/evil\.com/);
  });

  it('returns 200 silently when the email is NOT registered (no enumeration leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'ghost@nowhere.test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // No email sent — but the caller cannot know that.
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('returns 200 for invalid email format (still no leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(200);
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('persists the token hash, NOT the plain token (DB leak resistance)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'alice@diluxite.test' },
    });

    const msg = ctx.email.sent[0];
    const linkToken = new URL(
      msg.text.match(/https:\/\/\S+/)![0],
    ).searchParams.get('token')!;
    const expectedHash = createHash('sha256').update(linkToken).digest('hex');

    const rows = await ctx.passwordResets.findActiveByHash(expectedHash);
    expect(rows).toBeTruthy();
    expect(rows!.userId).toBe(ctx.user.id);

    // The plain token MUST NOT appear in the row.
    const all = await ctx.sql`SELECT token_hash FROM password_resets`;
    expect(all[0].token_hash).not.toBe(linkToken);
    expect(all[0].token_hash).toBe(expectedHash);
  });

  it('records an audit event for the request (only when user exists)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'alice@diluxite.test' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'ghost@nowhere.test' },
    });

    const events = await ctx.audit.list({ actionPrefix: 'auth.password.reset_requested' });
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(ctx.user.id);
  });

  it('returns 404 in local mode (no server-mode auth = no reset flow)', async () => {
    // Tear down the server-mode app and stand up a local-mode one against the
    // same Postgres. We override the afterEach hook's `app`/`sql` so cleanup
    // sees the local instance.
    await app.close();
    await sql.end();
    const conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    const usersLocal = new DrizzleUsersRepository(conn.db);
    const sessionsLocal = new DrizzleSessionsRepository(conn.db);
    const tokensLocal = new DrizzleTokensRepository(conn.db);
    const notesRepoLocal = new DrizzleNotesRepository(conn.db);
    const searchLocal = new SearchService(
      new DrizzleSearchRepository(conn.db),
      new DeterministicEmbeddingProvider(1536),
      notesRepoLocal,
    );
    app = await buildApp({
      notes: new NotesService(notesRepoLocal, searchLocal),
      search: searchLocal,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
      users: usersLocal,
      tokens: tokensLocal,
      sessions: sessionsLocal,
      tags: new DrizzleTagsRepository(conn.db),
      links: new DrizzleLinksRepository(conn.db),
      folders: new DrizzleFoldersRepository(conn.db),
      auth: new SessionAuthProvider(sessionsLocal, tokensLocal),
      // authMode 'local' is what makes /api/auth/forgot return 404.
      info: { embedder: 'deterministic', version: 'test', authMode: 'local' },
      email: new NoopEmailProvider(() => {}),
      passwordResets: new DrizzlePasswordResetsRepository(conn.db),
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email: 'alice@diluxite.test' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Forgot password — /api/auth/reset', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let ctx: Awaited<ReturnType<typeof bootstrap>>;

  async function requestReset(email: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot',
      payload: { email },
    });
    const msg = ctx.email.sent.at(-1)!;
    return new URL(msg.text.match(/https:\/\/\S+/)![0]).searchParams.get('token')!;
  }

  beforeEach(async () => {
    ctx = await bootstrap();
    app = ctx.app;
    sql = ctx.sql;
  });
  afterEach(async () => {
    await app?.close();
    await sql?.end();
  });

  it('updates the password + consumes the token + revokes all sessions', async () => {
    // First, create a session so we can prove it gets revoked.
    const oldSession = await ctx.sessions.createSession(ctx.user.id, undefined, {
      ip: '10.0.0.1',
      userAgent: 'tests',
    });
    expect(await ctx.sessions.findUserIdBySession(oldSession.token)).toBe(ctx.user.id);

    const token = await requestReset('alice@diluxite.test');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token, newPassword: 'brand-new-pass-xyz' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    // Password changed in DB.
    const updated = await ctx.users.findWithPasswordByEmail('alice@diluxite.test');
    expect(updated?.passwordHash).toBeTruthy();
    expect(verifyPassword('brand-new-pass-xyz', updated!.passwordHash!)).toBe(true);
    expect(verifyPassword('original-pass-123', updated!.passwordHash!)).toBe(false);

    // Old session was revoked.
    expect(await ctx.sessions.findUserIdBySession(oldSession.token)).toBeNull();

    // Token can't be reused.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token, newPassword: 'something-else-xyz' },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('rejects an unknown / malformed token with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token: 'definitely-not-a-real-token', newPassword: 'whatever-12345' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid|expired/i);
  });

  it('rejects passwords shorter than 8 chars with 400 (defense in depth)', async () => {
    const token = await requestReset('alice@diluxite.test');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token, newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('records audit events for both success and failure paths', async () => {
    const token = await requestReset('alice@diluxite.test');
    await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token, newPassword: 'good-pass-1234' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/reset',
      payload: { token: 'bogus', newPassword: 'another-pass-1234' },
    });

    const ok = await ctx.audit.list({ actionPrefix: 'auth.password.reset_completed' });
    expect(ok).toHaveLength(1);
    expect(ok[0].actorId).toBe(ctx.user.id);

    const failed = await ctx.audit.list({ actionPrefix: 'auth.password.reset_failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].actorId).toBeNull();
  });
});
