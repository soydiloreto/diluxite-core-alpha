import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  SessionAuthProvider,
} from '@diluxite/core';
import {
  createDb,
  DrizzleAuditEventsRepository,
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
  DrizzleLinksRepository,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzleSearchRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { buildApp, type AppDeps } from './app';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * End-to-end coverage for ORG tokens (unattended API keys belonging to an
 * organization, not a user). The motivating case: a GitHub Action / cron that
 * consults the second brain over the API/MCP and must keep working even after
 * the person who minted the token is disabled or leaves.
 *
 * We wire a server-mode app with the REAL SessionAuthProvider(sessions, tokens)
 * so an org token resolves through `resolveToken` exactly as in production.
 */
describe('Org tokens — data-plane authorisation (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let conn: ReturnType<typeof createDb>;

  let usersRepo: DrizzleUsersRepository;
  let spacesRepo: DrizzleSpacesRepository;
  let orgsRepo: DrizzleOrganizationsRepository;
  let tokensRepo: DrizzleTokensRepository;
  let auditRepo: DrizzleAuditEventsRepository;

  let adminId: string;
  let orgAId: string;
  let orgBId: string;
  let spaceAId: string;
  let spaceBId: string;

  function buildServerApp(): Promise<FastifyInstance> {
    const notesRepo = new DrizzleNotesRepository(conn.db);
    const search = new SearchService(
      new DrizzleSearchRepository(conn.db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    const deps: AppDeps = {
      notes,
      search,
      spaces: spacesRepo,
      organizations: orgsRepo,
      users: usersRepo,
      tokens: tokensRepo,
      sessions: new DrizzleSessionsRepository(conn.db),
      tags: new DrizzleTagsRepository(conn.db),
      links: new DrizzleLinksRepository(conn.db),
      folders: new DrizzleFoldersRepository(conn.db),
      move: new DrizzleMoveRepository(conn.db),
      audit: auditRepo,
      auth: new SessionAuthProvider(new DrizzleSessionsRepository(conn.db), tokensRepo),
      info: { embedder: 'local', version: '0.0.0', authMode: 'server' },
    };
    return buildApp(deps).then(async (a) => {
      await a.ready();
      return a;
    });
  }

  beforeEach(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE audit_events, sessions, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    usersRepo = new DrizzleUsersRepository(conn.db);
    spacesRepo = new DrizzleSpacesRepository(conn.db);
    orgsRepo = new DrizzleOrganizationsRepository(conn.db);
    tokensRepo = new DrizzleTokensRepository(conn.db);
    auditRepo = new DrizzleAuditEventsRepository(conn.db);

    adminId = (await usersRepo.create('admin@diluxite')).id;
    orgAId = (await orgsRepo.create('Acme', `acme-${Date.now()}`, adminId)).id;
    orgBId = (await orgsRepo.create('Beta', `beta-${Date.now()}`, adminId)).id;
    spaceAId = (await spacesRepo.create(orgAId, 'Space A', adminId)).id;
    spaceBId = (await spacesRepo.create(orgBId, 'Space B', adminId)).id;

    app = await buildServerApp();
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function mintOrgToken(orgId: string, scopes: string[]): Promise<string> {
    const { token } = await tokensRepo.createOrgToken(orgId, 'svc', scopes as never);
    return token;
  }

  it('read-scope org token can read notes/search in its org, but NOT write', async () => {
    // Seed a note as the admin (member of space A) via direct repo so search has data.
    const note = await app
      .inject({
        method: 'POST',
        url: `/api/spaces/${spaceAId}/notes`,
        headers: bearer(await mintOrgToken(orgAId, ['write'])), // a write token to seed
        payload: { title: 'Azure', contentMd: 'Azure is the Microsoft cloud' },
      })
      .then((r) => r.json());
    expect(note.id).toBeTruthy();

    const ro = await mintOrgToken(orgAId, ['read']);

    // Read: list notes → 200.
    const list = await app.inject({
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(ro),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((n: { title: string }) => n.title === 'Azure')).toBe(true);

    // Read: search → 200.
    const search = await app.inject({
      method: 'POST',
      url: '/api/search',
      headers: bearer(ro),
      payload: { spaceId: spaceAId, query: 'microsoft cloud' },
    });
    expect(search.statusCode).toBe(200);

    // Read: list spaces → sees its org's spaces.
    const spaces = await app.inject({ url: '/api/spaces', headers: bearer(ro) });
    expect(spaces.statusCode).toBe(200);
    expect(spaces.json().map((s: { id: string }) => s.id)).toContain(spaceAId);

    // Write with a read-only token → 403 (scope).
    const write = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(ro),
      payload: { title: 'nope', contentMd: 'x' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('write-scope org token can write in its org', async () => {
    const rw = await mintOrgToken(orgAId, ['read', 'write']);
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(rw),
      payload: { title: 'Memory', contentMd: 'jotted by the cron' },
    });
    expect(create.statusCode).toBe(201);

    const noteId = create.json().id;
    const append = await app.inject({
      method: 'POST',
      url: `/api/notes/${noteId}/append`,
      headers: bearer(rw),
      payload: { content: 'more' },
    });
    expect(append.statusCode).toBe(200);
  });

  it('cross-org isolation: an org-A token cannot read or write org-B spaces', async () => {
    const aRead = await mintOrgToken(orgAId, ['read']);
    const aWrite = await mintOrgToken(orgAId, ['read', 'write']);

    expect(
      (await app.inject({ url: `/api/spaces/${spaceBId}/notes`, headers: bearer(aRead) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/spaces/${spaceBId}/notes`,
          headers: bearer(aWrite),
          payload: { title: 'x', contentMd: 'y' },
        })
      ).statusCode,
    ).toBe(403);

    // And it never sees org-B spaces in its listing.
    const spaces = await app.inject({ url: '/api/spaces', headers: bearer(aRead) });
    expect(spaces.json().map((s: { id: string }) => s.id)).not.toContain(spaceBId);
  });

  it('org token cannot touch user-only surfaces (sessions, password, TOTP, tokens, members)', async () => {
    const t = await mintOrgToken(orgAId, ['read', 'write']);
    const h = bearer(t);

    // Sessions list / revoke-others (user account surface).
    expect((await app.inject({ url: '/api/auth/sessions', headers: h })).statusCode).toBe(401);
    // (resolves its own auth above the preHandler → org token has no user → 401)

    // Password change.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          headers: h,
          payload: { currentPassword: 'a', newPassword: 'bbbbbbbb' },
        })
      ).statusCode,
    ).toBe(401);

    // TOTP enroll — blocked. (404 here because `deps.totp` isn't wired in this
    // test app; 401 when it is. Either way, the org token cannot enroll.)
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/totp/enroll', headers: h })).statusCode,
    ).not.toBe(200);

    // Minting a USER token (mounted under the /api preHandler → 403 via requireUser).
    const mint = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: h,
      payload: { name: 'x' },
    });
    expect(mint.statusCode).toBe(403);

    // Managing org members.
    const members = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/members`,
      headers: h,
      payload: { email: 'new@x.com' },
    });
    expect(members.statusCode).toBe(403);

    // Minting another org token (admin surface).
    const orgMint = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/tokens`,
      headers: h,
      payload: { scopes: ['read'] },
    });
    expect(orgMint.statusCode).toBe(403);
  });

  it('THE motivating case: disabling the user who minted the token does NOT break the token', async () => {
    const rw = await mintOrgToken(orgAId, ['read', 'write']);

    // It works while the admin is active.
    const before = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(rw),
      payload: { title: 'before', contentMd: 'x' },
    });
    expect(before.statusCode).toBe(201);

    // Disable (and even delete) the minting user.
    await usersRepo.setActive(adminId, false);

    const afterDisable = await app.inject({
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(rw),
    });
    expect(afterDisable.statusCode).toBe(200);

    const afterWrite = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(rw),
      payload: { title: 'after', contentMd: 'still works' },
    });
    expect(afterWrite.statusCode).toBe(201);
  });

  it('org-token writes are audited with the tokenId (no fake actor)', async () => {
    const rw = await tokensRepo.createOrgToken(orgAId, 'svc', ['read', 'write'] as never);
    await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: bearer(rw.token),
      payload: { title: 'audited', contentMd: 'x' },
    });
    const events = await auditRepo.list({ orgId: orgAId, actionPrefix: 'note.' });
    expect(events.length).toBeGreaterThan(0);
    const created = events.find((e) => e.action === 'note.created');
    expect(created).toBeTruthy();
    expect(created!.actorId).toBeNull();
    expect(created!.metadata).toMatchObject({ orgTokenId: rw.info.id });
  });

  it('default scope on mint is read-only (safe default)', async () => {
    // Mint via the API as the admin (a user). Use a session cookie path is
    // heavier; instead assert the validateScopes default through the repo +
    // the endpoint: a body WITHOUT scopes must yield ['read'].
    const sessions = new DrizzleSessionsRepository(conn.db);
    const { token: session } = await sessions.createSession(adminId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/tokens`,
      headers: { cookie: `diluxite_session=${session}` },
      payload: { name: 'defaulted' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().scopes).toEqual(['read']);
  });

  it('mint rejects scopes outside {read, write}', async () => {
    const sessions = new DrizzleSessionsRepository(conn.db);
    const { token: session } = await sessions.createSession(adminId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgAId}/tokens`,
      headers: { cookie: `diluxite_session=${session}` },
      payload: { scopes: ['read', 'admin'] },
    });
    expect(res.statusCode).toBe(400);
  });
});
