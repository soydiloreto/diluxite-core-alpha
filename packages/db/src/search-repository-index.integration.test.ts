import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDb } from './client';
import {
  DrizzleEmbeddingModelsRepository,
  partitionNameOf,
  slotOf,
} from './embedding-models-repository';
import { DrizzleSearchRepository } from './search-repository';

/**
 * The query the repository ACTUALLY sends uses the vector index — ADR-003.
 *
 * The distinction is the whole point. A test that writes its own EXPLAIN,
 * shaped like what the repository is believed to send, stays green when the
 * repository stops sending it: the first version of this check did exactly
 * that, and removing the `model_key` filter from the shipped query left it
 * passing. So the SQL here is captured off the wire and explained verbatim.
 *
 * An index the planner never chooses reads as "we have an index" and performs
 * like a sequential scan — 98.6 ms against 4.3 ms at 20k vectors.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const MODEL = { provider: 'probe', model: 'index-check', dimensions: 64 };
const KEY = 'probe:index-check@64';
let ORG = '';
let SLOT = '';

describe('the shipped vector query', () => {
  const conn = createDb(TEST_DATABASE_URL);
  const { db, sql: raw } = conn;
  let spaceId: string;

  beforeAll(async () => {
    const spaces = await raw<{ id: string; org_id: string }[]>`
      SELECT id, org_id FROM spaces LIMIT 1`;
    spaceId = spaces[0]?.id ?? '00000000-0000-0000-0000-000000000000';
    ORG = spaces[0]?.org_id ?? '00000000-0000-0000-0000-000000000000';
    SLOT = slotOf(ORG, KEY);

    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(SLOT)}`);
    await raw`DELETE FROM embedding_models WHERE key = ${KEY}`;
    await new DrizzleEmbeddingModelsRepository(db).ensureRegistered(ORG, MODEL);

    // Enough rows that a sequential scan is not simply the cheapest plan.
    //
    // Real chunks, because `chunk_embeddings.chunk_id` is a foreign key. NOT
    // wrapped in a catch: an earlier version swallowed the error, and hid TWO
    // failures at once — a stale column list and this constraint — so the
    // suite seeded nothing and then reported "the planner did not use the
    // index", which was true and measured nothing.
    const [note] = await raw<{ id: string }[]>`
      INSERT INTO notes (space_id, title, content_md)
      VALUES (${spaceId}, ${'index-probe-' + Date.now()}, 'x') RETURNING id`;
    await raw.unsafe(
      `WITH seeded AS (
         INSERT INTO chunks (note_id, space_id, text, position)
         SELECT $4, $2, 'probe ' || g, g FROM generate_series(1, 4000) g
         RETURNING id
       )
       INSERT INTO chunk_embeddings (chunk_id, slot, org_id, space_id, embedding)
       SELECT s.id, $1, $3, $2,
              (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
               FROM generate_series(1, ${MODEL.dimensions}))
       FROM seeded s`,
      [SLOT, spaceId, ORG, note.id],
    );
    await raw`ANALYZE chunk_embeddings`;
  });

  afterAll(async () => {
    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(SLOT)}`);
    await raw`DELETE FROM embedding_models WHERE key = ${KEY}`;
    await raw.end();
  });

  it('is planned as an HNSW index scan over exactly one partition', async () => {
    const captured: { text: string; params: unknown[] }[] = [];
    const spy = postgres(TEST_DATABASE_URL, {
      debug: (_c, query, params) => captured.push({ text: query, params: params as unknown[] }),
    });
    try {
      const repo = new DrizzleSearchRepository(drizzle(spy));
      const probe = Array.from({ length: MODEL.dimensions }, () => 0.01);
      await repo.vectorSearch(spaceId, probe, 5, {
        slot: SLOT,
        orgId: ORG,
        dimensions: MODEL.dimensions,
      });

      // The repository also emits DDL the first time it sees a vector space
      // (creating the partition), so pick the SELECT rather than the first
      // statement that happens to name the table.
      const sent = captured.find(
        (q) => /^\s*select/i.test(q.text) && q.text.includes('chunk_embeddings'),
      );
      expect(sent, 'the repository sent no SELECT against chunk_embeddings').toBeTruthy();

      const plan = await raw.unsafe<Record<string, string>[]>(
        `EXPLAIN (COSTS OFF) ${sent!.text}`,
        sent!.params as never[],
      );
      const text = plan.map((r) => Object.values(r)[0]).join('\n');

      expect(text, `the shipped query does not use the HNSW index:\n${text}`).toMatch(
        /Index Scan using .*hnsw/i,
      );
      // `Append` means Postgres read every model's partition instead of one.
      expect(text, `the query did not prune to a single partition:\n${text}`).not.toMatch(/Append/);
    } finally {
      await spy.end();
    }
  });
});
