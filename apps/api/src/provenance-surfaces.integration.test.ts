import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Every write door records who came through it — ADR-002's PROV-O axis.
 *
 * The rule under test is not "provenance exists" but "each surface declares
 * its own, and the one that cannot name an author says so instead of guessing".
 * That distinction is the whole value: a record that quietly attributes a
 * collaborative flush to whoever happened to trigger it is worse than no
 * record, because it reads as true.
 */

interface ProvRow {
  attributed_to: string | null;
  agent_kind: string;
  generated_by: string;
  rank: string;
  valid_to: string | null;
}

describe('provenance is recorded at every write door', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let userId: string;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    userId = t.userId;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const provOf = async (noteId: string): Promise<ProvRow> => {
    const [row] = await sql<ProvRow[]>`
      SELECT attributed_to, agent_kind, generated_by, rank, valid_to
      FROM entity_provenance WHERE entity_kind = 'note' AND entity_id = ${noteId}`;
    return row;
  };

  const createNote = async (title: string): Promise<string> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd: 'inicial' },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  it('a note created over REST is attributed to the user, through the rest door', async () => {
    const id = await createNote('Creada');
    const prov = await provOf(id);
    expect(prov).toMatchObject({
      attributed_to: userId,
      agent_kind: 'user',
      generated_by: 'rest',
      rank: 'normal',
    });
    // The window is open: this note has not been superseded.
    expect(prov.valid_to).toBeNull();
  });

  it('a REST edit amends the provenance rather than adding a second row', async () => {
    const id = await createNote('Editada');
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { contentMd: 'cambiado' },
    });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM entity_provenance WHERE entity_id = ${id}`;
    expect(n).toBe(1);
    expect((await provOf(id)).generated_by).toBe('rest');
  });

  it('an append records the same identity as the write it is', async () => {
    const id = await createNote('Anexada');
    const r = await app.inject({
      method: 'POST',
      url: `/api/notes/${id}/append`,
      payload: { content: 'más' },
    });
    expect(r.statusCode).toBe(200);
    expect((await provOf(id)).attributed_to).toBe(userId);
  });

  it('every note gets a change-stats row, and content edits advance it', async () => {
    const id = await createNote('Contada');
    const stats = async () =>
      (
        await sql<{ change_count: number; avg_interval_seconds: number | null }[]>`
          SELECT change_count, avg_interval_seconds FROM entity_change_stats
          WHERE entity_kind = 'note' AND entity_id = ${id}`
      )[0];

    expect((await stats()).change_count).toBe(1);
    // One observation is not an interval yet.
    expect((await stats()).avg_interval_seconds).toBeNull();

    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v2' } });
    const after = await stats();
    expect(after.change_count).toBe(2);
    expect(after.avg_interval_seconds).not.toBeNull();
  });

  it('a retitle does NOT count as a change: the note is not saying something new', async () => {
    const id = await createNote('Original');
    const before = (
      await sql<{ change_count: number }[]>`
        SELECT change_count FROM entity_change_stats WHERE entity_id = ${id}`
    )[0].change_count;

    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { title: 'Renombrada' } });

    const after = (
      await sql<{ change_count: number }[]>`
        SELECT change_count FROM entity_change_stats WHERE entity_id = ${id}`
    )[0].change_count;
    // Counting it would teach the estimator this note changes more often than
    // it does, and every staleness answer downstream inherits that error.
    expect(after).toBe(before);
  });

  it('re-saving identical content counts nothing', async () => {
    const id = await createNote('Idéntica');
    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v2' } });
    const before = (
      await sql<{ change_count: number }[]>`
        SELECT change_count FROM entity_change_stats WHERE entity_id = ${id}`
    )[0].change_count;

    await app.inject({ method: 'PUT', url: `/api/notes/${id}`, payload: { contentMd: 'v2' } });

    const after = (
      await sql<{ change_count: number }[]>`
        SELECT change_count FROM entity_change_stats WHERE entity_id = ${id}`
    )[0].change_count;
    expect(after).toBe(before);
  });
});
