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
    // Its own organisation and workspace, not whatever another suite left
    // behind. Reading `SELECT ... FROM spaces LIMIT 1` made this file depend
    // on the order the suites happen to run in: run alone it found a row, run
    // with the rest it found none, fell back to a nil UUID, and died on the
    // `embedding_models.org_id` foreign key that per-org slots introduced.
    const stamp = `idx-probe-${process.pid}`;
    const [user] = await raw<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`${stamp}@diluxite`}) RETURNING id`;
    const [org] = await raw<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${stamp}, ${stamp}) RETURNING id`;
    const [space] = await raw<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id)
      VALUES (${stamp}, ${user.id}, ${org.id}) RETURNING id`;
    spaceId = space.id;
    ORG = org.id;
    SLOT = slotOf(ORG, KEY);

    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(SLOT)}`);
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
    // Las tres, no solo la de vectores. Con una base recién creada `notes` y
    // `chunks` no tienen estadísticas, el planner estima a ojo el resultado
    // del join y elige ordenar en vez de recorrer el índice — que es lo que
    // este test mide. Antes pasaba porque la base compartida venía cargada de
    // datos de otras suites, o sea el test dependía de vecinos.
    await raw`ANALYZE chunk_embeddings, chunks, notes`;
  });

  afterAll(async () => {
    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(SLOT)}`);
    await raw`DELETE FROM organizations WHERE id = ${ORG}`;
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
