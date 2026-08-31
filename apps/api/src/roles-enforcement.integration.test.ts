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
import { buildApp, type AppDeps } from '../src/app';

/**
 * Role enforcement (P1.1):
 *  a. POST /api/spaces fallback (no orgId) must require org admin/org_admin.
 *  b. An admin must NOT be able to demote/remove a org_admin TARGET; the
 *     POST upsert path must also honour the orphan guard.
 *  c. A `viewer` cannot create/edit/delete/purge notes or folders (403), but
 *     CAN read; an editor/admin can mutate.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const SUPER = { authorization: 'Bearer tokSuper' };
const ADMIN = { authorization: 'Bearer tokAdmin' };
const MEMBER = { authorization: 'Bearer tokMember' };
const VIEWER = { authorization: 'Bearer tokViewer' };
const EDITOR = { authorization: 'Bearer tokEditor' };

interface Ctx {
  app: FastifyInstance;
  sql: Sql;
  orgId: string;
  spaceId: string;
  superId: string;
  adminId: string;
  memberId: string;
  viewerId: string;
  editorId: string;
}

async function boot(): Promise<Ctx> {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, organizations, users RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const conn = createDb(TEST_DATABASE_URL);
  const { db } = conn;

  const users = new DrizzleUsersRepository(db);
  const spaces = new DrizzleSpacesRepository(db);
  const organizations = new DrizzleOrganizationsRepository(db);
  const sup = await users.create('super@diluxite');
  const admin = await users.create('admin@diluxite');
  const member = await users.create('member@diluxite');
  const viewer = await users.create('viewer@diluxite');
  const editor = await users.create('editor@diluxite');
  const org = await organizations.create('Acme', `acme-${Date.now()}`, sup.id); // sup = org_admin
  await organizations.addOrUpdateMember(org.id, admin.id, 'org_admin');
  await organizations.addOrUpdateMember(org.id, member.id, 'org_member');
  await organizations.addOrUpdateMember(org.id, viewer.id, 'org_member');
  await organizations.addOrUpdateMember(org.id, editor.id, 'org_member');
  // A workspace owned by the org_admin; grant viewer/editor their WS roles.
  const space = await spaces.create(org.id, 'Space', sup.id);
  await spaces.addOrUpdateMember(space.id, viewer.id, 'viewer');
  await spaces.addOrUpdateMember(space.id, editor.id, 'editor');

  const notesRepo = new DrizzleNotesRepository(db);
  const search = new SearchService(
    new DrizzleSearchRepository(db),
    new DeterministicEmbeddingProvider(1536),
    notesRepo,
  );
  const notes = new NotesService(notesRepo, search);
  const auth = new TokenAuthProvider(
    new Map([
      ['tokSuper', sup.id],
      ['tokAdmin', admin.id],
      ['tokMember', member.id],
      ['tokViewer', viewer.id],
      ['tokEditor', editor.id],
    ]),
  );
  const deps: AppDeps = {
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
    info: { embedder: 'local', version: '0', authMode: 'server' },
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    sql: conn.sql,
    orgId: org.id,
    spaceId: space.id,
    superId: sup.id,
    adminId: admin.id,
    memberId: member.id,
    viewerId: viewer.id,
    editorId: editor.id,
  };
}

describe('Role enforcement — P1.1', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await boot();
  });
  afterEach(async () => {
    await c.app.close();
    await c.sql.end();
  });

  // ── a. POST /api/spaces fallback (no orgId) requires admin role ──────────
  describe('POST /api/spaces fallback role gate', () => {
    it('a plain member cannot create a workspace via the first-org fallback', async () => {
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/spaces',
        headers: MEMBER,
        payload: { name: 'Sneaky' }, // no orgId → fallback to first org
      });
      expect(r.statusCode).toBe(403);
    });

    it('an org admin can create a workspace via the fallback', async () => {
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/spaces',
        headers: ADMIN,
        payload: { name: 'Legit' },
      });
      expect(r.statusCode).toBe(201);
    });
  });

  // ── b. Target-role checks on org member mutations ───────────────────────
  //
  // ADR-005 collapsed `super_admin` and `admin` into one `org_admin`, so the
  // rules that distinguished them are gone with them: there is no longer a
  // second-in-command who must be stopped from demoting the owner. What
  // remains is the rule that always mattered — an organisation cannot be left
  // with nobody able to administer it.
  describe('org member mutations', () => {
    // The fixture boots with two accounts that used to hold different
    // administrative roles and now hold the same one, so the organisation
    // starts with two org_admins.
    it('an org_admin can demote another org_admin', async () => {
      const r = await c.app.inject({
        method: 'PUT',
        url: `/api/organizations/${c.orgId}/members/${c.superId}`,
        headers: ADMIN,
        payload: { role: 'org_member' },
      });
      expect(r.statusCode).toBe(200);
    });

    it('but NOT the last one — the org would be left unadministrable', async () => {
      // Demote one of the two first, so the caller really is the last.
      await c.app.inject({
        method: 'PUT',
        url: `/api/organizations/${c.orgId}/members/${c.adminId}`,
        headers: SUPER,
        payload: { role: 'org_member' },
      });
      const r = await c.app.inject({
        method: 'PUT',
        url: `/api/organizations/${c.orgId}/members/${c.superId}`,
        headers: SUPER,
        payload: { role: 'org_member' },
      });
      expect(r.statusCode).toBe(409);
    });

    it('the same guard holds on the re-invite path, which is an upsert', async () => {
      // POST /members is an upsert, so it can demote. It used to be the way
      // around the guard, and is covered here for that reason.
      await c.app.inject({
        method: 'PUT',
        url: `/api/organizations/${c.orgId}/members/${c.adminId}`,
        headers: SUPER,
        payload: { role: 'org_member' },
      });
      const r = await c.app.inject({
        method: 'POST',
        url: `/api/organizations/${c.orgId}/members`,
        headers: SUPER,
        payload: { email: 'super@diluxite', role: 'org_member' },
      });
      expect(r.statusCode).toBe(409);
    });

    it('nor removed, for the same reason', async () => {
      await c.app.inject({
        method: 'PUT',
        url: `/api/organizations/${c.orgId}/members/${c.adminId}`,
        headers: SUPER,
        payload: { role: 'org_member' },
      });
      const r = await c.app.inject({
        method: 'DELETE',
        url: `/api/organizations/${c.orgId}/members/${c.superId}`,
        headers: SUPER,
      });
      expect([409, 403]).toContain(r.statusCode);
    });
  });
  // ── c. Viewer cannot mutate notes/folders; editor/admin can ─────────────
  describe('viewer is read-only on notes/folders', () => {
    async function seedNote(): Promise<string> {
      const r = await c.app.inject({
        method: 'POST',
        url: `/api/spaces/${c.spaceId}/notes`,
        headers: EDITOR,
        payload: { title: 'Seed', contentMd: 'hello' },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id;
    }

    it('viewer CAN read notes', async () => {
      await seedNote();
      const r = await c.app.inject({
        url: `/api/spaces/${c.spaceId}/notes`,
        headers: VIEWER,
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().length).toBe(1);
    });

    it('viewer CANNOT create a note (403)', async () => {
      const r = await c.app.inject({
        method: 'POST',
        url: `/api/spaces/${c.spaceId}/notes`,
        headers: VIEWER,
        payload: { title: 'Nope', contentMd: 'x' },
      });
      expect(r.statusCode).toBe(403);
    });

    it('viewer CANNOT edit a note (403)', async () => {
      const id = await seedNote();
      const r = await c.app.inject({
        method: 'PUT',
        url: `/api/notes/${id}`,
        headers: VIEWER,
        payload: { contentMd: 'tampered' },
      });
      expect(r.statusCode).toBe(403);
    });

    it('viewer CANNOT delete a note (403)', async () => {
      const id = await seedNote();
      const r = await c.app.inject({
        method: 'DELETE',
        url: `/api/notes/${id}`,
        headers: VIEWER,
      });
      expect(r.statusCode).toBe(403);
    });

    it('viewer CANNOT purge trash (403)', async () => {
      const r = await c.app.inject({
        method: 'DELETE',
        url: `/api/spaces/${c.spaceId}/trash`,
        headers: VIEWER,
      });
      expect(r.statusCode).toBe(403);
    });

    it('viewer CANNOT create a folder (403)', async () => {
      const r = await c.app.inject({
        method: 'POST',
        url: `/api/spaces/${c.spaceId}/folders`,
        headers: VIEWER,
        payload: { name: 'Folder' },
      });
      expect(r.statusCode).toBe(403);
    });

    it('editor CAN edit a note', async () => {
      const id = await seedNote();
      const r = await c.app.inject({
        method: 'PUT',
        url: `/api/notes/${id}`,
        headers: EDITOR,
        payload: { contentMd: 'edited' },
      });
      expect(r.statusCode).toBe(200);
    });

    it('org admin (no direct WS role) CAN edit a note via escalation', async () => {
      const id = await seedNote();
      const r = await c.app.inject({
        method: 'PUT',
        url: `/api/notes/${id}`,
        headers: ADMIN,
        payload: { contentMd: 'admin-edit' },
      });
      expect(r.statusCode).toBe(200);
    });
  });

  // ── #6 — POST /api/admin/reindex ────────────────────────────────────────
  describe('POST /api/admin/reindex', () => {
    async function seedNotes(n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        const r = await c.app.inject({
          method: 'POST',
          url: `/api/spaces/${c.spaceId}/notes`,
          headers: EDITOR,
          payload: { title: `Note ${i}`, contentMd: `content number ${i}` },
        });
        expect(r.statusCode).toBe(201);
      }
    }

    it('org_admin reindexes the whole org and gets the count back; search still works', async () => {
      await seedNotes(3);
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: SUPER,
        payload: { orgId: c.orgId },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().reindexed).toBe(3);

      // Idempotent — a second call reindexes the same notes without error.
      const again = await c.app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: SUPER,
        payload: { orgId: c.orgId },
      });
      expect(again.json().reindexed).toBe(3);

      // Search finds the reindexed content.
      const search = await c.app.inject({
        method: 'POST',
        url: '/api/search',
        headers: SUPER,
        payload: { query: 'content number', spaceId: c.spaceId, topK: 5 },
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().length).toBeGreaterThan(0);
    });

    it('a plain member cannot reindex (403)', async () => {
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: MEMBER,
        payload: { orgId: c.orgId },
      });
      expect(r.statusCode).toBe(403);
    });

    it('admin can reindex a single space (workspace-admin escalation)', async () => {
      await seedNotes(2);
      const r = await c.app.inject({
        method: 'POST',
        url: '/api/admin/reindex',
        headers: ADMIN,
        payload: { spaceId: c.spaceId },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().reindexed).toBe(2);
    });
  });
});
