import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  TokenAuthProvider,
} from '@diluxite/core';
import {
  createDb,
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
  DrizzleLinksRepository,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzleSearchRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { buildApp } from '../src/app';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const ADMIN = { authorization: 'Bearer tokAdmin' };

/**
 * Backend is the single source of truth for the "local mode is single-tenant"
 * invariant. The UI grises the buttons; these tests prove the API refuses the
 * same operations even when called directly (e.g. via curl), so the contract
 * is not engaña-pichanga.
 */
async function bootstrap(authMode: 'local' | 'server' | undefined) {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, organizations, users RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const conn = createDb(TEST_DATABASE_URL);
  const { sql, db } = conn;

  const users = new DrizzleUsersRepository(db);
  const spaces = new DrizzleSpacesRepository(db);
  const organizations = new DrizzleOrganizationsRepository(db);
  const admin = await users.create('admin@diluxite');
  const org = await organizations.create('Acme', `acme-${Date.now()}`, admin.id);

  const notesRepo = new DrizzleNotesRepository(db);
  const search = new SearchService(
    new DrizzleSearchRepository(db),
    new DeterministicEmbeddingProvider(1536),
    notesRepo,
  );
  const notes = new NotesService(notesRepo, search);
  const auth = new TokenAuthProvider(new Map([['tokAdmin', admin.id]]));

  const info =
    authMode === undefined
      ? undefined
      : { embedder: 'deterministic', version: 'test', authMode };

  const app = await buildApp({
    notes,
    search,
    spaces,
    organizations,
    users,
    tokens: new DrizzleTokensRepository(db),
    tags: new DrizzleTagsRepository(db),
    links: new DrizzleLinksRepository(db),
    folders: new DrizzleFoldersRepository(db),
    move: new DrizzleMoveRepository(db),
    auth,
    info,
  });
  await app.ready();
  return { app, sql, orgId: org.id };
}

describe('Auth-mode guards on organization endpoints', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;

  afterEach(async () => {
    await app?.close();
    await sql?.end();
  });

  describe('local mode', () => {
    beforeEach(async () => {
      ({ app, sql, orgId } = await bootstrap('local'));
    });

    it('refuses POST /api/organizations with 403', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: ADMIN,
        payload: { name: 'Second Org' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: 'organization creation requires server mode',
      });
    });

    it('refuses DELETE /api/organizations/:orgId with 403 even for super_admin', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: 'organization deletion requires server mode',
      });
    });

    it('refuses creation before checking the request body (no name leakage)', async () => {
      // Validation order matters: the mode guard runs first so callers can't
      // probe other validation errors to detect the install mode.
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: ADMIN,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('server mode', () => {
    beforeEach(async () => {
      ({ app, sql, orgId } = await bootstrap('server'));
    });

    it('allows POST /api/organizations and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: ADMIN,
        payload: { name: 'Second Org' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Second Org' });
    });

    it('allows DELETE /api/organizations/:orgId for super_admin', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true });
    });

    it('allows POST /api/organizations/:orgId/tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/tokens`,
        headers: ADMIN,
        payload: { name: 'ci-bot', scopes: ['read', 'write'] },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'ci-bot' });
    });
  });

  describe('org tokens — mode guard on POST + DELETE', () => {
    it('local mode refuses POST /api/organizations/:orgId/tokens with 403', async () => {
      ({ app, sql, orgId } = await bootstrap('local'));
      const res = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/tokens`,
        headers: ADMIN,
        payload: { name: 'sneaky', scopes: ['read'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'org tokens require server mode' });
    });

    it('local mode refuses DELETE /api/organizations/:orgId/tokens/:id with 403', async () => {
      ({ app, sql, orgId } = await bootstrap('local'));
      // No need to actually create a token first — the guard runs before the
      // params are even looked up, so any id (real or not) triggers the 403.
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}/tokens/whatever`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'org tokens require server mode' });
    });

    it('GET stays open in both modes (read-only, useful for inspection)', async () => {
      ({ app, sql, orgId } = await bootstrap('local'));
      const res = await app.inject({
        method: 'GET',
        url: `/api/organizations/${orgId}/tokens`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('missing info (fail-closed)', () => {
    // If a deployment forgets to wire `info`, the safer default is to refuse
    // multi-tenant ops — better than silently allowing them.
    beforeEach(async () => {
      ({ app, sql, orgId } = await bootstrap(undefined));
    });

    it('refuses POST /api/organizations with 403 when info is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/organizations',
        headers: ADMIN,
        payload: { name: 'X' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('refuses DELETE /api/organizations/:orgId with 403 when info is missing', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/organizations/${orgId}`,
        headers: ADMIN,
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
