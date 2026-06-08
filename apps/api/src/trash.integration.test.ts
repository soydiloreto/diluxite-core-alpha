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

const OWNER = { authorization: 'Bearer tokOwner' };
const STRANGER = { authorization: 'Bearer tokStranger' };

/**
 * Trash bin (alpha.43) — soft-delete contract.
 *
 * These tests prove the *observable* behaviour: a deleted note disappears
 * from listings + search, lives in /trash, can be restored, and only
 * `/purge` actually drops the row.
 */
async function bootstrap() {
  const clean = createDb(TEST_DATABASE_URL);
  await clean.sql`TRUNCATE chunks, notes, memberships, spaces, organizations, users RESTART IDENTITY CASCADE`;
  await clean.sql.end();

  const conn = createDb(TEST_DATABASE_URL);
  const { sql, db } = conn;

  const users = new DrizzleUsersRepository(db);
  const owner = await users.create('owner@diluxite.test');
  const stranger = await users.create('stranger@diluxite.test');
  const orgs = new DrizzleOrganizationsRepository(db);
  const org = await orgs.create('Acme', `acme-${Date.now()}`, owner.id);
  const spaces = new DrizzleSpacesRepository(db);
  const space = await spaces.create(org.id, 'Workspace', owner.id);

  const notesRepo = new DrizzleNotesRepository(db);
  const search = new SearchService(
    new DrizzleSearchRepository(db),
    new DeterministicEmbeddingProvider(1536),
    notesRepo,
  );
  const notes = new NotesService(notesRepo, search);
  const auth = new TokenAuthProvider(
    new Map([
      ['tokOwner', owner.id],
      ['tokStranger', stranger.id],
    ]),
  );
  const app = await buildApp({
    notes,
    search,
    spaces,
    organizations: orgs,
    users,
    tokens: new DrizzleTokensRepository(db),
    tags: new DrizzleTagsRepository(db),
    links: new DrizzleLinksRepository(db),
    folders: new DrizzleFoldersRepository(db),
    auth,
    info: { embedder: 'deterministic', version: 'test', authMode: 'server' },
  });
  await app.ready();

  // Seed one note.
  const noteRes = await app.inject({
    method: 'POST',
    url: `/api/spaces/${space.id}/notes`,
    headers: OWNER,
    payload: { title: 'My first note', contentMd: '# Hello\n\nsome content' },
  });
  const note = noteRes.json() as { id: string; title: string };

  return { app, sql, space, note };
}

describe('Trash bin — soft delete contract', () => {
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

  it('DELETE /notes/:id moves the note to trash; it disappears from list, stays in /trash', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}`,
      headers: OWNER,
    });
    expect(del.statusCode).toBe(200);

    // Active listing skips it.
    const list = await app.inject({
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
    });
    expect(list.json()).toHaveLength(0);

    // GET /notes/:id 404 (filtered by deleted_at IS NULL).
    const get = await app.inject({
      url: `/api/notes/${ctx.note.id}`,
      headers: OWNER,
    });
    expect(get.statusCode).toBe(404);

    // It IS in the trash.
    const trash = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect(trash.statusCode).toBe(200);
    const items = trash.json() as { id: string; title: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: ctx.note.id, title: 'My first note' });
  });

  it('POST /notes/:id/restore brings it back to the active listing', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}`,
      headers: OWNER,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/notes/${ctx.note.id}/restore`,
      headers: OWNER,
    });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
    });
    expect((list.json() as unknown[]).length).toBe(1);

    const trash = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect((trash.json() as unknown[]).length).toBe(0);
  });

  it('restore works with an empty JSON body (the browser sends content-type but no payload)', async () => {
    await app.inject({ method: 'DELETE', url: `/api/notes/${ctx.note.id}`, headers: OWNER });
    // Reproduces the real client exactly: the CSRF helper sets
    // `content-type: application/json` while the request carries NO body.
    // Used to 400 ("Body cannot be empty…"); must restore cleanly now.
    const res = await app.inject({
      method: 'POST',
      url: `/api/notes/${ctx.note.id}/restore`,
      headers: { ...OWNER, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('restore of a non-trashed note returns 409', async () => {
    // Don't delete first.
    const res = await app.inject({
      method: 'POST',
      url: `/api/notes/${ctx.note.id}/restore`,
      headers: OWNER,
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETE /notes/:id/purge removes the row only if it was in trash', async () => {
    // Try to purge a live note → 409 (must trash first).
    const tooSoon = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}/purge`,
      headers: OWNER,
    });
    expect(tooSoon.statusCode).toBe(409);

    // Soft delete first, then purge.
    await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}`,
      headers: OWNER,
    });
    const purge = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}/purge`,
      headers: OWNER,
    });
    expect(purge.statusCode).toBe(200);

    // Now it's gone forever — 404 even in trash.
    const trash = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect((trash.json() as unknown[]).length).toBe(0);
    const purgeAgain = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}/purge`,
      headers: OWNER,
    });
    expect(purgeAgain.statusCode).toBe(404);
  });

  it('DELETE /spaces/:id/trash empties the trash for the workspace', async () => {
    // Trash two more notes.
    const a = await app.inject({
      method: 'POST',
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
      payload: { title: 'A' },
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
      payload: { title: 'B' },
    });
    for (const note of [ctx.note, a.json(), b.json()]) {
      await app.inject({
        method: 'DELETE',
        url: `/api/notes/${(note as { id: string }).id}`,
        headers: OWNER,
      });
    }
    const before = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect((before.json() as unknown[]).length).toBe(3);

    const empty = await app.inject({
      method: 'DELETE',
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ ok: true, purged: 3 });

    const after = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect((after.json() as unknown[]).length).toBe(0);
  });

  it('strangers cannot see trash or restore notes from other workspaces', async () => {
    await app.inject({
      method: 'DELETE',
      url: `/api/notes/${ctx.note.id}`,
      headers: OWNER,
    });

    const trash = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: STRANGER,
    });
    expect(trash.statusCode).toBe(403);

    const restore = await app.inject({
      method: 'POST',
      url: `/api/notes/${ctx.note.id}/restore`,
      headers: STRANGER,
    });
    expect(restore.statusCode).toBe(404);
  });

  it('multi-delete moves all to trash; they all show up in /trash', async () => {
    const a = await app.inject({
      method: 'POST',
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
      payload: { title: 'A' },
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/spaces/${ctx.space.id}/notes`,
      headers: OWNER,
      payload: { title: 'B' },
    });
    const aId = (a.json() as { id: string }).id;
    const bId = (b.json() as { id: string }).id;

    const del = await app.inject({
      method: 'POST',
      url: '/api/notes/delete-many',
      headers: OWNER,
      payload: { ids: [ctx.note.id, aId, bId] },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: 3 });

    const trash = await app.inject({
      url: `/api/spaces/${ctx.space.id}/trash`,
      headers: OWNER,
    });
    expect((trash.json() as unknown[]).length).toBe(3);
  });
});
