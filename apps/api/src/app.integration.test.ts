import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

describe('REST API (integration via Fastify inject)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('GET /health responds ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().service).toBe('diluxite-core');
  });

  it('lists the default space', async () => {
    const r = await app.inject({ url: '/api/spaces' });
    expect(r.statusCode).toBe(200);
    expect(r.json().length).toBeGreaterThanOrEqual(1);
  });

  it('full cycle: create → read → list → search → delete', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Azure', contentMd: 'Azure is the Microsoft cloud' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    expect((await app.inject({ url: `/api/notes/${id}` })).json().title).toBe('Azure');
    expect((await app.inject({ url: `/api/spaces/${spaceId}/notes` })).json()).toHaveLength(1);

    const search = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'the microsoft cloud' },
    });
    expect(search.json()[0].title).toBe('Azure');

    expect((await app.inject({ method: 'DELETE', url: `/api/notes/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/notes/${id}` })).statusCode).toBe(404);
  });

  it('PUT updates the content', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'T', contentMd: 'v1' },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/notes/${create.json().id}`,
      payload: { contentMd: 'v2' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().contentMd).toBe('v2');
  });

  it('validates payload: note without title => 400', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/notes`, payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('missing note => 404', async () => {
    const r = await app.inject({ url: '/api/notes/00000000-0000-0000-0000-000000000000' });
    expect(r.statusCode).toBe(404);
  });

  it('DELETE a space that still has notes cascades instead of 500', async () => {
    // Regression: notes.space_id was ON DELETE NO ACTION until migration
    // 0018, so deleting a non-empty space hit an FK violation (HTTP 500 with
    // the raw Postgres message leaked).
    const createSpace = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Doomed' },
    });
    expect(createSpace.statusCode).toBe(201);
    const doomedId = createSpace.json().id as string;

    const note = await app.inject({
      method: 'POST',
      url: `/api/spaces/${doomedId}/notes`,
      payload: { title: 'Inside', contentMd: 'goes down with the ship' },
    });
    expect(note.statusCode).toBe(201);
    const noteId = note.json().id as string;

    const del = await app.inject({ method: 'DELETE', url: `/api/spaces/${doomedId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    // Space and its notes are actually gone.
    const remainingNotes = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM notes WHERE id = ${noteId}`;
    expect(remainingNotes[0].n).toBe('0');
    const remainingSpaces = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM spaces WHERE id = ${doomedId}`;
    expect(remainingSpaces[0].n).toBe('0');
  });

  // ── IDOR: a note must not be filed under a folder of another space ───────
  it('POST notes with a folderId from a DIFFERENT space → 400', async () => {
    // Second space owned by the same single user → it IS a member, so the
    // 400 we expect is the folder-ownership guard, not a 403/404 access check.
    const otherSpace = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Other' },
    });
    const otherSpaceId = otherSpace.json().id as string;
    const folder = await app.inject({
      method: 'POST',
      url: `/api/spaces/${otherSpaceId}/folders`,
      payload: { name: 'Foreign folder' },
    });
    const foreignFolderId = folder.json().id as string;

    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'X', contentMd: 'y', folderId: foreignFolderId },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error).toMatch(/folder does not belong/i);
  });

  it('PUT note moving it into a folder of another space → 400', async () => {
    const note = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Movable', contentMd: 'z' },
    });
    const noteId = note.json().id as string;

    const otherSpace = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Other2' },
    });
    const folder = await app.inject({
      method: 'POST',
      url: `/api/spaces/${otherSpace.json().id}/folders`,
      payload: { name: 'F2' },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/notes/${noteId}`,
      payload: { folderId: folder.json().id },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/folder does not belong/i);
  });

  // ── Global error handler: bad input is 4xx, never a 500 leaking the driver ─
  it('GET /api/notes/:id with a malformed UUID → 400 (not a 500)', async () => {
    const r = await app.inject({ url: '/api/notes/not-a-uuid' });
    expect(r.statusCode).toBe(400);
    // No Postgres detail leaked.
    expect(JSON.stringify(r.json())).not.toMatch(/22P02|invalid input syntax|postgres/i);
  });

  it('create note with a non-string title → 400 (not a 500)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 123, contentMd: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('create note with a non-string contentMd → 400 (not a 500)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'ok', contentMd: { not: 'a string' } },
    });
    expect(r.statusCode).toBe(400);
  });

  it('PUT folder with a non-string name → 400 (not a 500)', async () => {
    const folder = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name: 'real' },
    });
    const r = await app.inject({
      method: 'PUT',
      url: `/api/folders/${folder.json().id}`,
      payload: { name: 999 },
    });
    expect(r.statusCode).toBe(400);
  });

  it('notes list tolerates a repeated query param (?tag=a&tag=b) without 500', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/notes?tag=a&tag=b` });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });
});
