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

const A = { authorization: 'Bearer tokA' };
const B = { authorization: 'Bearer tokB' };

describe('Multi-user API: isolation and sharing (security RS-2)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceAId: string;

  beforeEach(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    const conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    const { db } = conn;

    const users = new DrizzleUsersRepository(db);
    const spaces = new DrizzleSpacesRepository(db);
    const organizations = new DrizzleOrganizationsRepository(db);
    const a = await users.create('a@diluxite');
    await users.create('b@diluxite');
    // Every space lives inside an org now; A creates one and her workspace within it.
    const org = await organizations.create('Acme', `acme-${Date.now()}`, a.id);
    const spaceA = await spaces.create(org.id, 'Space A', a.id);
    spaceAId = spaceA.id;

    const notesRepo = new DrizzleNotesRepository(db);
    const search = new SearchService(
      new DrizzleSearchRepository(db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    const auth = new TokenAuthProvider(
      new Map([
        ['tokA', a.id],
        ['tokB', (await users.findByEmail('b@diluxite'))!.id],
      ]),
    );

    const tokens = new DrizzleTokensRepository(db);
    const tags = new DrizzleTagsRepository(db);
    const links = new DrizzleLinksRepository(db);
    const folders = new DrizzleFoldersRepository(db);
    app = await buildApp({
      notes,
      search,
      spaces,
      organizations,
      users,
      tokens,
      tags,
      links,
      folders,
      auth,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('without token => 401', async () => {
    expect((await app.inject({ url: '/api/spaces' })).statusCode).toBe(401);
  });

  it("isolation: B cannot see or access A's notes", async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: A,
      payload: { title: 'Secret', contentMd: 'private data' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    expect((await app.inject({ url: `/api/spaces/${spaceAId}/notes`, headers: B })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: B })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: A })).statusCode).toBe(200);
  });

  it('sharing: after inviting B, they can access the whole space', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/notes`,
      headers: A,
      payload: { title: 'N', contentMd: 'x' },
    });
    const id = create.json().id;

    const invite = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/members`,
      headers: A,
      payload: { email: 'b@diluxite' },
    });
    // The membership endpoint returns 201 (Created) under the v4.1 admin API.
    expect(invite.statusCode).toBe(201);

    expect((await app.inject({ url: `/api/spaces/${spaceAId}/notes`, headers: B })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/notes/${id}`, headers: B })).statusCode).toBe(200);
  });

  it('non-owner cannot invite', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceAId}/members`,
      headers: B,
      payload: { email: 'a@diluxite' },
    });
    expect(invite.statusCode).toBe(403);
  });
});
