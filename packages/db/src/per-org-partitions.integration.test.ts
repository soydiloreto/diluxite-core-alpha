import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDb } from './client';
import {
  DrizzleEmbeddingModelsRepository,
  partitionNameOf,
  slotOf,
} from './embedding-models-repository';

/**
 * Why each organisation gets its own partition — ADR-005.
 *
 * Not tidiness, and not really about letting each tenant pick a provider.
 * A shared HNSW index returns the SMALL tenant nothing: the index hands back
 * its nearest candidates, they all belong to the large tenant, and the tenant
 * filter removes every one. The small tenant searches, finds nothing, and
 * nothing errors — which is the worst shape a multi-tenant defect can take.
 *
 * This measures it both ways, because a claim like that is worth nothing
 * unless the failing case is demonstrated alongside the fixed one.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const DIMS = 128;
const SMALL = 10;
const LARGE = 8000;

describe('a tenant sharing an index with a bigger one', () => {
  const conn = createDb(TEST_DATABASE_URL);
  const { db, sql: raw } = conn;
  const models = new DrizzleEmbeddingModelsRepository(db);

  let orgA = '';
  let orgB = '';
  let spaceA = '';
  let spaceB = '';

  const randomVector = () =>
    raw`SELECT ('[' || string_agg(random()::text, ',') || ']')::vector AS v
        FROM generate_series(1, ${DIMS})`;

  beforeAll(async () => {
    const stamp = Date.now();
    const mk = async (tag: string) => {
      const [u] = await raw<{ id: string }[]>`
        INSERT INTO users (email) VALUES (${`${tag}${stamp}@part.test`}) RETURNING id`;
      const [o] = await raw<{ id: string }[]>`
        INSERT INTO organizations (name, slug) VALUES (${tag}, ${tag + stamp}) RETURNING id`;
      const [s] = await raw<{ id: string }[]>`
        INSERT INTO spaces (org_id, name, owner_id) VALUES (${o.id}, ${tag}, ${u.id}) RETURNING id`;
      const [n] = await raw<{ id: string }[]>`
        INSERT INTO notes (space_id, title, content_md) VALUES (${s.id}, ${tag}, 'x') RETURNING id`;
      return { org: o.id, space: s.id, note: n.id };
    };
    const a = await mk('partA');
    const b = await mk('partB');
    orgA = a.org;
    orgB = b.org;
    spaceA = a.space;
    spaceB = b.space;

    await models.ensureRegistered(orgA, { provider: 'probe', model: 'shared', dimensions: DIMS });
    await models.ensureRegistered(orgB, { provider: 'probe', model: 'shared', dimensions: DIMS });

    const seed = async (org: string, space: string, note: string, slot: string, n: number) => {
      await raw.unsafe(
        `WITH seeded AS (
           INSERT INTO chunks (note_id, space_id, text, position)
           SELECT $4, $2, 'c' || g, g FROM generate_series(1, ${n}) g
           RETURNING id
         )
         INSERT INTO chunk_embeddings (chunk_id, slot, org_id, space_id, embedding)
         SELECT s.id, $1, $3, $2,
                (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
                 FROM generate_series(1, ${DIMS}))
         FROM seeded s`,
        [slot, space, org, note],
      );
    };
    const slotA = slotOf(orgA, 'probe:shared@' + DIMS);
    const slotB = slotOf(orgB, 'probe:shared@' + DIMS);
    await seed(orgA, spaceA, a.note, slotA, SMALL);
    await seed(orgB, spaceB, b.note, slotB, LARGE);
    await raw`ANALYZE chunk_embeddings`;
  });

  afterAll(async () => {
    const parts = await raw<{ relname: string }[]>`
      SELECT relname FROM pg_class WHERE relname LIKE 'chunk_embeddings\\_%' AND relkind = 'r'`;
    for (const p of parts) await raw.unsafe(`DROP TABLE IF EXISTS ${p.relname}`);
    await raw`DELETE FROM embedding_models WHERE provider = 'probe'`;
    await raw`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await raw.end();
  });

  it('the small tenant gets ALL of its nearest neighbours back', async () => {
    // Its own partition, so its ten vectors are the only ones the index knows
    // about. Five of five, including its own vector at distance zero.
    const [{ v }] = await randomVector();
    await raw.unsafe('SET enable_seqscan = off');
    const rows = await raw.unsafe(
      `SELECT chunk_id FROM chunk_embeddings
       WHERE slot = $1 AND space_id = $2
       ORDER BY embedding::vector(${DIMS}) <=> $3::vector(${DIMS})
       LIMIT 5`,
      [slotOf(orgA, 'probe:shared@' + DIMS), spaceA, v as string],
    );
    await raw.unsafe('RESET enable_seqscan');
    expect(rows.length, 'the small tenant lost results to its neighbour').toBe(5);
  });

  it('and the same query pooled into ONE index returns it nothing — the reason for all this', async () => {
    // The failing case, demonstrated rather than asserted. Both tenants'
    // vectors in a single index, and the small one asks for five.
    await raw`DROP TABLE IF EXISTS pooled_probe`;
    await raw.unsafe(`CREATE TABLE pooled_probe (id serial primary key, tenant text, embedding vector(${DIMS}))`);
    await raw.unsafe(
      `INSERT INTO pooled_probe (tenant, embedding)
       SELECT 'B', (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
                    FROM generate_series(1, ${DIMS}))
       FROM generate_series(1, ${LARGE})`,
    );
    await raw.unsafe(
      `INSERT INTO pooled_probe (tenant, embedding)
       SELECT 'A', (SELECT ('[' || string_agg(random()::text, ',') || ']')::vector
                    FROM generate_series(1, ${DIMS}))
       FROM generate_series(1, ${SMALL})`,
    );
    await raw`CREATE INDEX pooled_probe_hnsw ON pooled_probe USING hnsw (embedding vector_cosine_ops)`;
    await raw`ANALYZE pooled_probe`;

    const [{ v }] = await randomVector();
    await raw.unsafe('SET enable_seqscan = off');
    const rows = await raw.unsafe(
      `SELECT id FROM pooled_probe WHERE tenant = 'A'
       ORDER BY embedding <=> $1::vector(${DIMS}) LIMIT 5`,
      [v as string],
    );
    await raw.unsafe('RESET enable_seqscan');
    await raw`DROP TABLE pooled_probe`;

    // Fewer than five: the index's nearest candidates all belong to B and the
    // tenant filter removes them. Asserted as "fewer" rather than "zero"
    // because it depends on how the graph happens to be built — the point is
    // that it is lossy at all, and separate partitions are not.
    expect(rows.length, 'pooling did not lose results — recheck the premise').toBeLessThan(5);
  });

  it('two organisations on the SAME model still get separate partitions', async () => {
    const a = partitionNameOf(slotOf(orgA, 'probe:shared@' + DIMS));
    const b = partitionNameOf(slotOf(orgB, 'probe:shared@' + DIMS));
    expect(a).not.toBe(b);
    const rows = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY(${[a, b]})`;
    expect(rows[0].n).toBe(2);
  });

  it("and one organisation's vectors are physically absent from the other's partition", async () => {
    // Isolation gains a physical dimension on top of the row filter: not
    // "filtered out", simply not there.
    const b = partitionNameOf(slotOf(orgB, 'probe:shared@' + DIMS));
    const [{ n }] = await raw.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ONLY ${b} WHERE org_id = $1`,
      [orgA],
    );
    expect(n).toBe(0);
  });
});
