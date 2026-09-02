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

  describe('validity: the doors ADR-002 shipped without (migration 0036)', () => {
    it('GET /validity answers who wrote it, since when, and its measured rhythm', async () => {
      const id = await createNote('Umbral de fraude');
      const r = await app.inject({ url: `/api/notes/${id}/validity` });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.provenance.rank).toBe('normal');
      expect(body.provenance.validTo).toBeNull();
      expect(body.provenance.confirmedAt).toBeNull();
      expect(body.expired).toBe(false);
      expect(body.stats).not.toBeNull();
    });

    it('supersede closes the window and deprecates, and reinstate undoes it', async () => {
      const id = await createNote('Ya no vale');
      const off = (await app.inject({ method: 'POST', url: `/api/notes/${id}/supersede` })).json();
      expect(off.rank).toBe('deprecated');
      expect(off.validTo).not.toBeNull();

      const back = (await app.inject({ method: 'POST', url: `/api/notes/${id}/reinstate` })).json();
      expect(back.rank).toBe('normal');
      expect(back.validTo).toBeNull();
    });

    it('an expiry in the future leaves the rank alone and does not read as expired yet', async () => {
      const id = await createNote('Contrato');
      const at = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
      const r = (
        await app.inject({ method: 'PUT', url: `/api/notes/${id}/valid-to`, payload: { validTo: at } })
      ).json();
      // The distinction the whole feature rests on: an expiry is not a
      // supersession. It becomes expired by the passing of time, with nothing
      // scheduled to make it happen.
      expect(r.rank).toBe('normal');
      expect(new Date(r.validTo).getTime()).toBeGreaterThan(Date.now());
      expect((await app.inject({ url: `/api/notes/${id}/validity` })).json().expired).toBe(false);
    });

    it('an expiry already past reads as expired', async () => {
      const id = await createNote('Vencida');
      const at = new Date(Date.now() + 1000).toISOString();
      await app.inject({ method: 'PUT', url: `/api/notes/${id}/valid-to`, payload: { validTo: at } });
      // Age the whole window instead of waiting: a note that existed for ten
      // days and expired yesterday. Moving only `valid_to` back would close a
      // window before it opened, which the table refuses — correctly.
      await sql`
        UPDATE entity_provenance
           SET valid_from = now() - interval '10 days',
               valid_to   = now() - interval '1 day'
         WHERE entity_id = ${id}`;
      expect((await app.inject({ url: `/api/notes/${id}/validity` })).json().expired).toBe(true);
    });

    it('a date before the note existed is a 400, not a 500', async () => {
      const id = await createNote('Imposible');
      const r = await app.inject({
        method: 'PUT',
        url: `/api/notes/${id}/valid-to`,
        payload: { validTo: '1999-01-01T00:00:00.000Z' },
      });
      expect(r.statusCode).toBe(400);
    });

    it('confirming signs it WITHOUT rewriting who wrote it', async () => {
      const id = await createNote('Firmada');
      const before = (await app.inject({ url: `/api/notes/${id}/validity` })).json().provenance;

      const r = (await app.inject({ method: 'POST', url: `/api/notes/${id}/confirm` })).json();
      expect(r.rank).toBe('preferred');
      expect(r.confirmedAt).not.toBeNull();
      expect(r.confirmedBy).not.toBeNull();
      // The whole reason confirmation got its own columns: the author is the
      // author. Collapsing the two would make the last reviewer the author of
      // every page in the company.
      expect(r.attributedTo).toBe(before.attributedTo);
    });

    it('a superseded note cannot be confirmed', async () => {
      const id = await createNote('Muerta');
      await app.inject({ method: 'POST', url: `/api/notes/${id}/supersede` });
      const r = await app.inject({ method: 'POST', url: `/api/notes/${id}/confirm` });
      expect(r.statusCode).toBe(409);
    });
  });
});
