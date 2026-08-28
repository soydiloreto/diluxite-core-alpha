import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Version history over REST. The snapshots are of what the note USED to say
 * (recorded by NotesService before each content-changing save), a burst of
 * saves coalesces into one snapshot, and restore is a NEW save on top.
 */
describe('note version history (REST integration)', () => {
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

  async function createNote(contentMd: string, title = 'Nota'): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  it('a content save records the previous state; a burst coalesces into one', async () => {
    const id = await createNote('v1');

    let r = await app.inject({ url: `/api/notes/${id}/versions` });
    expect(r.json()).toEqual([]); // nothing replaced yet

    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v2' } });
    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v3' } });

    r = await app.inject({ url: `/api/notes/${id}/versions` });
    const list = r.json() as { id: string; title: string; contentMd?: string }[];
    // Two saves inside the coalescing window → ONE snapshot: the pre-burst v1.
    expect(list).toHaveLength(1);
    expect(list[0].contentMd).toBeUndefined(); // listing is meta-only

    const full = await app.inject({ url: `/api/notes/${id}/versions/${list[0].id}` });
    expect(full.json().contentMd).toBe('v1');
  });

  it('restore brings the old content back as a new save', async () => {
    const id = await createNote('v1');
    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v2' } });
    const [version] = (await app.inject({ url: `/api/notes/${id}/versions` })).json();

    const r = await app.inject({
      method: 'POST',
      url: `/api/notes/${id}/versions/${version.id}/restore`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().contentMd).toBe('v1');
    expect((await app.inject({ url: `/api/notes/${id}` })).json().contentMd).toBe('v1');
  });

  it('a version of another note is 404, and unknown ids are 404', async () => {
    const a = await createNote('a1', 'Nota A');
    const b = await createNote('b1', 'Nota B');
    await app.inject({ method: 'PUT', url: `/api/notes/${a}`, payload: { contentMd: 'a2' } });
    const [aVersion] = (await app.inject({ url: `/api/notes/${a}/versions` })).json();

    const cross = await app.inject({ url: `/api/notes/${b}/versions/${aVersion.id}` });
    expect(cross.statusCode).toBe(404);
    const crossRestore = await app.inject({
      method: 'POST',
      url: `/api/notes/${b}/versions/${aVersion.id}/restore`,
    });
    expect(crossRestore.statusCode).toBe(404);
    expect((await app.inject({ url: `/api/notes/${b}` })).json().contentMd).toBe('b1');
  });
});
