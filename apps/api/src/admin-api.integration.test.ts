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
const MEMBER = { authorization: 'Bearer tokMember' };
const STRANGER = { authorization: 'Bearer tokStranger' };

describe('Admin API: organizations + roles', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;

  beforeEach(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notes, memberships, spaces, organizations, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    const conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    const { db } = conn;

    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);
    const organizations = new DrizzleOrganizationsRepository(db);
    const admin = await users.create('admin@diluxite');
    const member = await users.create('member@diluxite');
    const stranger = await users.create('stranger@diluxite');
    const org = await organizations.create('Acme', `acme-${Date.now()}`, admin.id);
    await organizations.addOrUpdateMember(org.id, member.id, 'member');
    orgId = org.id;

    const notesRepo = new DrizzleNotesRepository(db);
    const search = new SearchService(
      new DrizzleSearchRepository(db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    const auth = new TokenAuthProvider(
      new Map([
        ['tokAdmin', admin.id],
        ['tokMember', member.id],
        ['tokStranger', stranger.id],
      ]),
    );
    app = buildApp({
      notes,
      search,
      spaces,
      organizations,
      users,
      tokens: new DrizzleTokensRepository(db),
      tags: new DrizzleTagsRepository(db),
      links: new DrizzleLinksRepository(db),
      folders: new DrizzleFoldersRepository(db),
      auth,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('lists only the orgs the user belongs to', async () => {
    const a = await app.inject({ url: '/api/organizations', headers: ADMIN });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toHaveLength(1);

    const s = await app.inject({ url: '/api/organizations', headers: STRANGER });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toHaveLength(0);
  });

  it('a stranger sees 404 on an org they do not belong to', async () => {
    const res = await app.inject({ url: `/api/organizations/${orgId}`, headers: STRANGER });
    expect(res.statusCode).toBe(404);
  });

  it('only super_admins can rename the org', async () => {
    const byMember = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}`,
      headers: MEMBER,
      payload: { name: 'Hacked' },
    });
    expect(byMember.statusCode).toBe(403);

    const byAdmin = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}`,
      headers: ADMIN,
      payload: { name: 'Acme 2' },
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('invite by email auto-creates the user and grants the requested role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgId}/members`,
      headers: ADMIN,
      payload: { email: 'newbie@diluxite', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('admin');

    const members = await app.inject({
      url: `/api/organizations/${orgId}/members`,
      headers: ADMIN,
    });
    expect(members.json().map((m: { email: string }) => m.email)).toContain('newbie@diluxite');
  });

  it('cannot demote the only super_admin (orphan guard)', async () => {
    const adminUser = (await app.inject({
      url: `/api/organizations/${orgId}/members`,
      headers: ADMIN,
    }))
      .json()
      .find((m: { role: string }) => m.role === 'super_admin');
    const demote = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/members/${adminUser.userId}`,
      headers: ADMIN,
      payload: { role: 'admin' },
    });
    expect(demote.statusCode).toBe(409);
  });

  it('member promoting another to super_admin is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgId}/members`,
      headers: MEMBER,
      payload: { email: 'someone@diluxite', role: 'super_admin' },
    });
    // Member can't add anyone at all.
    expect(res.statusCode).toBe(403);
  });

  it('org admin can create a workspace inside the org', async () => {
    const ws = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: ADMIN,
      payload: { orgId, name: 'Team A' },
    });
    expect(ws.statusCode).toBe(201);
    const list = await app.inject({
      url: `/api/organizations/${orgId}/workspaces`,
      headers: ADMIN,
    });
    expect(list.json().map((s: { name: string }) => s.name)).toContain('Team A');
  });

  it('per-workspace member ACL gates note access', async () => {
    const wsRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: ADMIN,
      payload: { orgId, name: 'Private' },
    });
    const spaceId = wsRes.json().id;

    // Member is org-member but not in the workspace — 403.
    const denied = await app.inject({
      url: `/api/spaces/${spaceId}/notes`,
      headers: MEMBER,
    });
    expect(denied.statusCode).toBe(403);

    // Org admin grants viewer role.
    const grant = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      headers: ADMIN,
      payload: { email: 'member@diluxite', role: 'viewer' },
    });
    expect(grant.statusCode).toBe(201);

    const allowed = await app.inject({
      url: `/api/spaces/${spaceId}/notes`,
      headers: MEMBER,
    });
    expect(allowed.statusCode).toBe(200);
  });
});
