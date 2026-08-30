import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDb } from './client';
import { DrizzleEmbeddingModelsRepository, partitionNameOf } from './embedding-models-repository';
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

describe('the shipped vector query', () => {
  const conn = createDb(TEST_DATABASE_URL);
  const { db, sql: raw } = conn;
  let spaceId: string;

  beforeAll(async () => {
    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(KEY)}`);
    await raw`DELETE FROM embedding_models WHERE key = ${KEY}`;
    await new DrizzleEmbeddingModelsRepository(db).ensureRegistered(MODEL);

    const spaces = await raw<{ id: string }[]>`SELECT id FROM spaces LIMIT 1`;
    spaceId = spaces[0]?.id ?? '00000000-0000-0000-0000-000000000000';

    // Enough rows that a sequential scan is not simply the cheapest plan.
    await raw.unsafe(
      `INSERT INTO chunk_embeddings (chunk_id, model_key, space_id, embedding)
       SELECT gen_random_uuid(), $1, $2,
              (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
               FROM generate_series(1, ${MODEL.dimensions}))
       FROM generate_series(1, 4000)`,
      [KEY, spaceId],
    ).catch(() => undefined);
    await raw`ANALYZE chunk_embeddings`;
  });

  afterAll(async () => {
    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(KEY)}`);
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
      await repo.vectorSearch(spaceId, probe, 5, { key: KEY, dimensions: MODEL.dimensions });

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
