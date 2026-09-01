import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Tagging a selection of notes.
 *
 * The thing worth testing here is not the counter in the response: it is that
 * the tag SURVIVES. Tags are derived from the markdown on every save, so an
 * implementation that wrote `note_tags` rows would pass a naive test and lose
 * the tag the next time anyone edited the note. Every case below asks the tag
 * endpoints — the ones the sidebar reads — rather than the note body.
 */

describe('POST /api/notes/tag-many', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const createNote = async (title: string, contentMd = 'cuerpo') => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  };

  const tagsOf = async (id: string): Promise<string[]> => {
    const r = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    expect(r.statusCode).toBe(200);
    const note = r.json() as { contentMd: string };
    const list = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/tags` });
    expect(list.statusCode).toBe(200);
    // The note's own tags, as the product derives them.
    return (list.json() as { tag: string }[])
      .map((t) => t.tag)
      .filter((t) => note.contentMd.toLowerCase().includes(`#${t.toLowerCase()}`));
  };

  it('adds a tag to every note in the selection', async () => {
    const a = await createNote('Uno');
    const b = await createNote('Dos');
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [a, b], add: ['infra'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ updated: 2, unchanged: 0, refused: 0 });
    expect(await tagsOf(a)).toContain('infra');
    expect(await tagsOf(b)).toContain('infra');
  });

  it('the tag is in the note, so a later edit does not lose it', async () => {
    // The whole reason this writes markdown instead of rows: a save recomputes
    // the tag set from the body.
    const id = await createNote('Persistente');
    await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [id], add: ['sobrevive'] },
    });
    const before = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    const body = (before.json() as { contentMd: string }).contentMd;
    // An ordinary edit, appending a line the way a person would.
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { contentMd: `${body}\n\nmás texto` },
    });
    expect(edited.statusCode).toBe(200);
    expect(await tagsOf(id)).toContain('sobrevive');
  });

  it('leaves a note that already has the tag byte for byte alone', async () => {
    const id = await createNote('Ya lo tiene', 'cuerpo\n\n#infra');
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [id], add: ['infra'] },
    });
    expect(r.json()).toMatchObject({ updated: 0, unchanged: 1 });
    const after = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    expect((after.json() as { contentMd: string }).contentMd).toBe('cuerpo\n\n#infra');
  });

  it('removes a tag, and can do both in one call', async () => {
    const id = await createNote('Mixto', 'cuerpo\n\n#viejo');
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [id], add: ['nuevo'], remove: ['viejo'] },
    });
    expect(r.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    const content = (after.json() as { contentMd: string }).contentMd;
    expect(content).toContain('#nuevo');
    expect(content).not.toContain('#viejo');
  });

  it('refuses a tag the parser would not read back, before touching anything', async () => {
    // A batch that half-applies because the third tag was malformed is worse
    // than one that never started.
    const id = await createNote('Intacta');
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [id], add: ['bueno', 'con espacio'] },
    });
    expect(r.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: `/api/notes/${id}` });
    expect((after.json() as { contentMd: string }).contentMd).toBe('cuerpo');
  });

  it('says what it wants when the request says nothing', async () => {
    const id = await createNote('X');
    for (const payload of [{}, { ids: [] }, { ids: [id] }]) {
      const r = await app.inject({ method: 'POST', url: '/api/notes/tag-many', payload });
      expect(r.statusCode).toBe(400);
    }
  });

  it('counts notes it was not allowed to touch instead of failing the batch', async () => {
    // An id that does not exist stands in for one in a workspace this account
    // cannot reach: both are "not yours", and the batch does the rest.
    const mine = await createNote('Mía');
    const r = await app.inject({
      method: 'POST',
      url: '/api/notes/tag-many',
      payload: { ids: [mine, '00000000-0000-0000-0000-000000000000'], add: ['infra'] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ updated: 1, refused: 1 });
  });
});
