import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Sql } from 'postgres';
import { createDb } from './client';
import {
  DrizzleEntityProvenanceRepository,
  EWMA_ALPHA,
  foldInterval,
} from './entity-provenance-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * ADR-002's three axes and its decay estimate, against a real Postgres.
 *
 * The arithmetic is unit-tested first, on purpose: it is the entire
 * "learning" this system does, and if it needed a database to be understood
 * that would be a sign it was doing something it should not.
 */

describe('foldInterval — the whole of the learning, and it is one multiply-add', () => {
  it('adopts the first observation outright: one sample has no history to blend', () => {
    expect(foldInterval(null, 3600)).toBe(3600);
  });

  it('weights the newest gap by alpha and the running average by the rest', () => {
    // 0.3 * 100 + 0.7 * 200 = 170
    expect(foldInterval(200, 100)).toBeCloseTo(170, 6);
  });

  it('converges toward a stable cadence instead of jumping to it', () => {
    let avg: number | null = null;
    for (let i = 0; i < 20; i++) avg = foldInterval(avg, 86_400);
    expect(avg).toBeCloseTo(86_400, 3);
  });

  it('lets one unusual gap move the estimate without owning it', () => {
    // A note that changed daily for a while, then sat untouched for a month.
    let avg: number | null = null;
    for (let i = 0; i < 10; i++) avg = foldInterval(avg, 86_400);
    const afterQuietMonth = foldInterval(avg, 30 * 86_400);
    // It moves — a month of silence is real information...
    expect(afterQuietMonth).toBeGreaterThan(avg!);
    // ...but the estimate is not simply "a month" after a single observation.
    expect(afterQuietMonth).toBeLessThan(30 * 86_400);
    expect(afterQuietMonth).toBeCloseTo(EWMA_ALPHA * 30 * 86_400 + (1 - EWMA_ALPHA) * 86_400, 3);
  });
});

describe('DrizzleEntityProvenanceRepository (Postgres integration)', () => {
  let sql: Sql;
  let conn: ReturnType<typeof createDb>;
  let repo: DrizzleEntityProvenanceRepository;
  let spaceId: string;
  let userId: string;
  let noteId: string;

  beforeEach(async () => {
    conn = createDb(TEST_URL);
    sql = conn.sql;
    await sql`TRUNCATE entity_provenance, entity_change_stats, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('prov@diluxite', 'local') RETURNING id`;
    userId = u.id;
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Prov', ${'prov-' + Date.now()}) RETURNING id`;
    const [sp] = await sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('S', ${userId}, ${org.id}) RETURNING id`;
    spaceId = sp.id;
    const [n] = await sql<{ id: string }[]>`
      INSERT INTO notes (space_id, title, content_md) VALUES (${spaceId}, 'N', 'x') RETURNING id`;
    noteId = n.id;
    repo = new DrizzleEntityProvenanceRepository(conn.db);
  });

  afterEach(async () => {
    await sql.end();
  });

  // ── PROV-O ─────────────────────────────────────────────────────────────

  it('records the agent, the activity and what it was derived from', async () => {
    await repo.record('note', noteId, spaceId, {
      attributedTo: userId,
      agentKind: 'user',
      generatedBy: 'editor',
      derivedFromRef: 'repo-a:docs/adr/adr-001.md',
    });

    const got = await repo.get('note', noteId);
    expect(got).toMatchObject({
      entityKind: 'note',
      entityId: noteId,
      attributedTo: userId,
      agentKind: 'user',
      generatedBy: 'editor',
      derivedFromRef: 'repo-a:docs/adr/adr-001.md',
      rank: 'normal',
    });
    expect(got!.validTo).toBeNull();
  });

  // A collab flush is authored by whoever typed during the debounce, which can
  // be several people. Storing a plausible single author would be inventing
  // provenance — worse than admitting there is none, because it looks true.
  it('accepts an unattributed write rather than inventing an author', async () => {
    await repo.record('note', noteId, spaceId, {
      attributedTo: null,
      agentKind: 'unknown',
      generatedBy: 'collab',
    });
    const got = await repo.get('note', noteId);
    expect(got!.attributedTo).toBeNull();
    expect(got!.agentKind).toBe('unknown');
    expect(got!.generatedBy).toBe('collab');
  });

  it('amends provenance in place on a second write', async () => {
    await repo.record('note', noteId, spaceId, { attributedTo: userId, generatedBy: 'editor' });
    await repo.record('note', noteId, spaceId, { attributedTo: userId, generatedBy: 'mcp' });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM entity_provenance WHERE entity_id = ${noteId}`;
    expect(n).toBe(1);
    expect((await repo.get('note', noteId))!.generatedBy).toBe('mcp');
  });

  // ── Bitemporal + rank ──────────────────────────────────────────────────

  it('supersede closes the window and deprecates WITHOUT deleting the row', async () => {
    await repo.record('note', noteId, spaceId, { attributedTo: userId });
    const at = new Date();
    await repo.supersede('note', noteId, at);

    const got = await repo.get('note', noteId);
    expect(got).toBeTruthy(); // the row survives — that is the whole point
    expect(got!.rank).toBe('deprecated');
    expect(got!.validTo).not.toBeNull();
    expect(got!.validTo!.getTime()).toBeCloseTo(at.getTime(), -2);
  });

  it('supersede is idempotent — the window closes once', async () => {
    // `validFrom` has to precede the close, or the history is impossible and
    // the constraint says so. The first draft of this test superseded 60s in
    // the PAST of a row valid from now, and was rejected — correctly.
    const opened = new Date(Date.now() - 2 * 3600 * 1000);
    await repo.record('note', noteId, spaceId, {}, { validFrom: opened });

    const first = new Date(Date.now() - 3600 * 1000);
    await repo.supersede('note', noteId, first);
    await repo.supersede('note', noteId, new Date());

    const got = await repo.get('note', noteId);
    expect(got!.validTo!.getTime()).toBeCloseTo(first.getTime(), -2);
  });

  it('keeps the two timelines apart: recorded_at is ours, valid_from is the world\'s', async () => {
    // Backfilling something that was true last year: it was valid then, we
    // learned it now. Collapsing these into one column makes "what did we
    // believe in March" permanently unanswerable.
    const lastYear = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    await repo.record('note', noteId, spaceId, {}, { validFrom: lastYear });

    const got = await repo.get('note', noteId);
    expect(got!.validFrom.getTime()).toBeCloseTo(lastYear.getTime(), -2);
    expect(got!.recordedAt.getTime()).toBeGreaterThan(lastYear.getTime());
  });

  it('refuses a window that closes before it opens', async () => {
    await repo.record('note', noteId, spaceId, {});
    await expect(
      sql`UPDATE entity_provenance SET valid_to = valid_from - interval '1 day'
          WHERE entity_id = ${noteId}`,
    ).rejects.toThrow(/entity_provenance_window_ordered/);
  });

  it('refuses a rank outside the three Wikidata values', async () => {
    await expect(
      sql`INSERT INTO entity_provenance (entity_kind, entity_id, space_id, rank)
          VALUES ('note', ${noteId}, ${spaceId}, 'muy-confiable')`,
    ).rejects.toThrow(/entity_provenance_rank_known/);
  });

  // ── Change statistics ──────────────────────────────────────────────────

  it('the first change starts the row and leaves the average unknown', async () => {
    await repo.recordChange('note', noteId, spaceId);
    const s = await repo.stats('note', noteId);
    expect(s!.changeCount).toBe(1);
    // One observation is not an interval. NULL sends the reader to the
    // structural prior instead of to a number invented here.
    expect(s!.avgIntervalSeconds).toBeNull();
  });

  it('the second change measures the gap; the third folds into it', async () => {
    const t0 = new Date(Date.now() - 3 * 3600 * 1000);
    const t1 = new Date(t0.getTime() + 3600 * 1000); // +1h
    const t2 = new Date(t1.getTime() + 3600 * 1000); // +1h

    await repo.recordChange('note', noteId, spaceId, t0);
    await repo.recordChange('note', noteId, spaceId, t1);
    expect((await repo.stats('note', noteId))!.avgIntervalSeconds).toBeCloseTo(3600, 3);

    await repo.recordChange('note', noteId, spaceId, t2);
    const s = await repo.stats('note', noteId);
    expect(s!.changeCount).toBe(3);
    expect(s!.avgIntervalSeconds).toBeCloseTo(3600, 3);
  });

  it('learns a slow cadence and a fast one differently, from the same code', async () => {
    const [other] = await sql<{ id: string }[]>`
      INSERT INTO notes (space_id, title, content_md) VALUES (${spaceId}, 'Fast', 'x') RETURNING id`;

    const day = 24 * 3600 * 1000;
    let t = Date.now() - 40 * day;
    for (let i = 0; i < 5; i++) {
      await repo.recordChange('note', noteId, spaceId, new Date(t));
      t += 10 * day; // a slow note: every ten days
    }
    let f = Date.now() - 5 * 3600 * 1000;
    for (let i = 0; i < 5; i++) {
      await repo.recordChange('note', other.id, spaceId, new Date(f));
      f += 3600 * 1000; // a fast one: hourly
    }

    const slow = (await repo.stats('note', noteId))!.avgIntervalSeconds!;
    const fast = (await repo.stats('note', other.id))!.avgIntervalSeconds!;
    expect(slow).toBeCloseTo(10 * 24 * 3600, -1);
    expect(fast).toBeCloseTo(3600, -1);
    // Nobody labelled either note. The difference came out of the timestamps.
    expect(slow / fast).toBeGreaterThan(100);
  });

  it('ignores a non-positive gap instead of poisoning the average', async () => {
    const t = new Date();
    await repo.recordChange('note', noteId, spaceId, t);
    await repo.recordChange('note', noteId, spaceId, new Date(t.getTime() + 3600_000));
    const before = (await repo.stats('note', noteId))!.avgIntervalSeconds;

    // Two writes in the same tick, or a clock that stepped backwards.
    await repo.recordChange('note', noteId, spaceId, t);
    const after = await repo.stats('note', noteId);
    expect(after!.changeCount).toBe(3);
    expect(after!.avgIntervalSeconds).toBe(before);
  });

  it('reinstate re-opens a window closed by mistake, back to normal — not to preferred', async () => {
    await repo.record('note', noteId, spaceId, {});
    await repo.supersede('note', noteId);
    await repo.reinstate('note', noteId);
    const row = (await repo.get('note', noteId))!;
    expect(row.validTo).toBeNull();
    // Reinstating is not a confirmation: it hands back existence, not
    // authority nobody re-checked.
    expect(row.rank).toBe('normal');
  });

  it('setValidTo declares a FUTURE expiry and leaves the rank alone', async () => {
    await repo.record('note', noteId, spaceId, {});
    const at = new Date(Date.now() + 7 * 24 * 3600_000);
    await repo.setValidTo('note', noteId, at);
    const row = (await repo.get('note', noteId))!;
    expect(row.validTo?.getTime()).toBe(at.getTime());
    expect(row.rank).toBe('normal');
    await repo.setValidTo('note', noteId, null);
    expect((await repo.get('note', noteId))!.validTo).toBeNull();
  });

  it('confirm signs it and lifts the rank WITHOUT touching who wrote it', async () => {
    await repo.record('note', noteId, spaceId, { attributedTo: userId, agentKind: 'user' });
    expect(await repo.confirm('note', noteId, userId)).toBe(true);
    const row = (await repo.get('note', noteId))!;
    expect(row.rank).toBe('preferred');
    expect(row.confirmedBy).toBe(userId);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.attributedTo).toBe(userId);
  });

  it('confirm refuses a superseded entity', async () => {
    await repo.record('note', noteId, spaceId, {});
    await repo.supersede('note', noteId);
    // Deprecated and preferred at once is not a state anybody can explain.
    expect(await repo.confirm('note', noteId, userId)).toBe(false);
    expect((await repo.get('note', noteId))!.rank).toBe('deprecated');
  });
});
