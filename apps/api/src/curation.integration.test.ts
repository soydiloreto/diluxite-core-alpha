import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * The weekly batch, end to end: what gets proposed, what an owner may answer,
 * and — the part that makes it more than a survey — that the answer reaches
 * the note.
 */
describe('curation queue (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  async function createNote(title: string, contentMd = 'x') {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    return r.json().id as string;
  }

  /** Pretend the memory leaned on this note N times. */
  async function used(noteId: string, times: number) {
    await sql`
      INSERT INTO entity_usage (entity_kind, entity_id, space_id, use_count)
      VALUES ('note', ${noteId}, ${spaceId}, ${times})
      ON CONFLICT (entity_kind, entity_id) DO UPDATE SET use_count = ${times}`;
  }

  const build = async (minutes?: number) =>
    app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/curation/build`,
      payload: minutes ? { minutes } : {},
    });

  const batch = async () =>
    (await app.inject({ url: `/api/spaces/${spaceId}/curation` })).json() as {
      id: string;
      noteId: string;
      title: string;
      useCount: number;
    }[];

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('proposes what the memory leans on, and nothing it never used', async () => {
    const read = await createNote('Umbral de fraude');
    await createNote('Nunca leída');
    await used(read, 20);

    expect((await build()).statusCode).toBe(200);
    const items = await batch();
    expect(items.map((i) => i.title)).toEqual(['Umbral de fraude']);
  });

  it('the batch never exceeds the budget, and the bar rises instead', async () => {
    for (let i = 0; i < 15; i++) await used(await createNote(`N${i}`), i + 1);
    // Nothing has been decided yet, so the cold-start budget applies: propose
    // a small batch and learn the real pace from it.
    const r = (await build()).json();
    expect(r.budget).toBe(10);
    const items = await batch();
    expect(items).toHaveLength(10);
    // The ten most leaned-on, not the first ten.
    expect(items[0].useCount).toBe(15);
    expect(items.some((i) => i.useCount === 1)).toBe(false);
  });

  it('rebuilding REPLACES the open batch — there is no backlog', async () => {
    const a = await createNote('A');
    await used(a, 5);
    await build();
    const first = await batch();
    await build();
    const second = await batch();
    expect(second).toHaveLength(first.length);
    // New rows, not accumulated ones.
    expect(second[0].id).not.toBe(first[0].id);
  });

  it('"it still holds" signs the note, not just the card', async () => {
    const n = await createNote('Firmable');
    await used(n, 5);
    await build();
    const [item] = await batch();

    const r = await app.inject({
      method: 'POST',
      url: `/api/curation/${item.id}/decide`,
      payload: { decision: 'confirmed' },
    });
    expect(r.statusCode).toBe(200);

    // A batch whose answers do not reach the note is a survey.
    const validity = (await app.inject({ url: `/api/notes/${n}/validity` })).json();
    expect(validity.provenance.rank).toBe('preferred');
    expect(validity.provenance.confirmedAt).not.toBeNull();
    expect(await batch()).toHaveLength(0);
  });

  it('"no longer true" supersedes the note and keeps it readable', async () => {
    const n = await createNote('Vieja');
    await used(n, 5);
    await build();
    const [item] = await batch();

    await app.inject({
      method: 'POST',
      url: `/api/curation/${item.id}/decide`,
      payload: { decision: 'superseded' },
    });

    const validity = (await app.inject({ url: `/api/notes/${n}/validity` })).json();
    expect(validity.provenance.rank).toBe('deprecated');
    expect((await app.inject({ url: `/api/notes/${n}` })).statusCode).toBe(200);
  });

  it('a rejection without a reason is refused', async () => {
    const n = await createNote('Rechazable');
    await used(n, 5);
    await build();
    const [item] = await batch();

    // An owner must not be able to drop something from the memory's record in
    // silence: the reason is what makes a rejection visible and appealable.
    const bad = await app.inject({
      method: 'POST',
      url: `/api/curation/${item.id}/decide`,
      payload: { decision: 'rejected' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: `/api/curation/${item.id}/decide`,
      payload: { decision: 'rejected', reason: 'duplica el acta de agosto' },
    });
    expect(good.statusCode).toBe(200);
    const [row] = await sql<{ reason: string }[]>`
      SELECT reason FROM curation_queue WHERE id = ${item.id}`;
    expect(row.reason).toBe('duplica el acta de agosto');
  });

  it('deciding the same card twice is a 404, not a second signature', async () => {
    const n = await createNote('Doble');
    await used(n, 5);
    await build();
    const [item] = await batch();
    const url = `/api/curation/${item.id}/decide`;
    expect((await app.inject({ method: 'POST', url, payload: { decision: 'confirmed' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, payload: { decision: 'confirmed' } })).statusCode).toBe(404);
  });

  it('refuses a decision it does not know', async () => {
    const n = await createNote('X');
    await used(n, 5);
    await build();
    const [item] = await batch();
    const r = await app.inject({
      method: 'POST',
      url: `/api/curation/${item.id}/decide`,
      payload: { decision: 'quizás' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('does not spend the budget on archived, trashed or already-superseded notes', async () => {
    const archived = await createNote('Archivada');
    const trashed = await createNote('En la papelera');
    const dead = await createNote('Ya superada');
    for (const id of [archived, trashed, dead]) await used(id, 50);
    await app.inject({ method: 'PUT', url: `/api/notes/${archived}/archive`, payload: { archived: true } });
    await app.inject({ method: 'DELETE', url: `/api/notes/${trashed}` });
    await app.inject({ method: 'POST', url: `/api/notes/${dead}/supersede` });

    await build();
    expect(await batch()).toEqual([]);
  });
});
