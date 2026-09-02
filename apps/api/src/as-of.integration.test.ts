import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';
import { noteAsOf, asOfBlock } from './as-of';

/**
 * "What did we believe in March?" — the question that arrives after a decision
 * goes wrong, and the reason ADR-002 keeps two timelines instead of one.
 */
describe('as-of (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;
  let noteId: string;

  const DAY = 86_400_000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

  beforeEach(async () => {
    ({ app, sql, deps, defaultSpaceId: spaceId } = await buildTestApp());
    noteId = (
      await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: { title: 'Umbral', contentMd: 'el umbral es 3%' },
      })
    ).json().id as string;
    // The note has existed for three months, so "in March" is a question about
    // its life rather than about the moment before it was written.
    await sql`
      UPDATE entity_provenance SET valid_from = now() - interval '90 days'
       WHERE entity_id = ${noteId}`;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  /** Save a new body and backdate the snapshot it produced. */
  async function editAndBackdate(contentMd: string, when: Date) {
    await app.inject({ method: 'PUT', url: `/api/notes/${noteId}`, payload: { contentMd } });
    await sql`
      UPDATE note_versions SET created_at = ${when.toISOString()}::timestamp
       WHERE note_id = ${noteId} AND created_at > now() - interval '1 minute'`;
  }

  it('answers with the text that was live then, not with today’s', async () => {
    await editAndBackdate('el umbral es 4%', daysAgo(30));

    const answer = (await noteAsOf(deps, noteId, daysAgo(60)))!;
    expect(answer.contentMd).toBe('el umbral es 3%');
    expect(answer.current).toBe(false);
  });

  it('says "unchanged since" when nothing was saved after that moment', async () => {
    const answer = (await noteAsOf(deps, noteId, daysAgo(1)))!;
    expect(answer.contentMd).toBe('el umbral es 3%');
    expect(answer.current).toBe(true);
    expect(asOfBlock(answer)).toMatch(/unchanged since/);
  });

  it('refuses to invent the past once the cap has dropped old snapshots', async () => {
    // Only truncation makes a moment unanswerable. For a note saved three
    // times the first snapshot still holds the original text, so an earlier
    // question is perfectly answerable — refusing there would be a lie in the
    // other direction.
    // Every snapshot is younger than the moment asked about AND the cap is
    // full: the oldest one we still have already contains edits made after
    // that moment, so quoting it would be fiction.
    await sql`
      INSERT INTO note_versions (note_id, space_id, title, content_md, created_at)
      SELECT ${noteId}, ${spaceId}, 'Umbral', 'relleno', now() - interval '20 days'
        FROM generate_series(1, 100)`;

    const answer = (await noteAsOf(deps, noteId, daysAgo(60)))!;
    expect(answer.contentMd).toBeNull();
    expect(asOfBlock(answer)).toMatch(/cannot see back/i);
  });

  it('says the note did not exist yet', async () => {
    const answer = (await noteAsOf(deps, noteId, daysAgo(400)))!;
    expect(answer.standing).toBe('not-yet-written');
    expect(asOfBlock(answer)).toMatch(/did not exist yet/);
  });

  it('a note superseded LATER still reads as held back then', async () => {
    await app.inject({ method: 'POST', url: `/api/notes/${noteId}/supersede` });

    const answer = (await noteAsOf(deps, noteId, new Date(Date.now() - 1000)))!;
    // Superseding closes the window; it does not rewrite what was believed
    // before it closed.
    expect(answer.standing).toBe('held');
    expect(asOfBlock(answer)).toMatch(/held as current then/);
  });

  it('a note superseded BEFORE the moment says so, with the date', async () => {
    await app.inject({ method: 'POST', url: `/api/notes/${noteId}/supersede` });
    await sql`
      UPDATE entity_provenance
         SET valid_from = now() - interval '60 days', valid_to = now() - interval '30 days'
       WHERE entity_id = ${noteId}`;

    const answer = (await noteAsOf(deps, noteId, daysAgo(10)))!;
    expect(answer.standing).toBe('superseded');
    expect(asOfBlock(answer)).toMatch(/no longer true/i);
  });

  it('the route refuses a date that is not one, and one in the future', async () => {
    expect((await app.inject({ url: `/api/notes/${noteId}/as-of?at=el%20viernes` })).statusCode).toBe(400);
    const future = new Date(Date.now() + DAY).toISOString();
    expect((await app.inject({ url: `/api/notes/${noteId}/as-of?at=${future}` })).statusCode).toBe(400);
  });

  it('the route answers the same thing the service does', async () => {
    const at = daysAgo(1).toISOString();
    const r = await app.inject({ url: `/api/notes/${noteId}/as-of?at=${at}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ noteId, contentMd: 'el umbral es 3%', standing: 'held' });
  });
});
