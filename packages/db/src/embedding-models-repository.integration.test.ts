import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from './client';
import {
  DrizzleEmbeddingModelsRepository,
  modelKeyOf,
  partitionNameOf,
  slotOf,
} from './embedding-models-repository';

/**
 * The embedding model catalogue — ADR-003.
 *
 * What is really under test is that the invariants live in the DATABASE and
 * not in the code that calls it: one active model, at most two models ever,
 * and a partition that can actually be indexed. Anything enforced only by
 * this repository's own discipline would survive a careless refactor and
 * break search silently, which is the failure mode ADR-003 exists to remove.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

const conn = createDb(TEST_DATABASE_URL);
const { db, sql: raw } = conn;
const repo = new DrizzleEmbeddingModelsRepository(db);

const OLLAMA = { provider: 'ollama', model: 'mxbai-embed-large', dimensions: 1024 };
const AZURE = { provider: 'azure', model: 'text-embedding-3-large', dimensions: 1536 };
/** Same dimension as Ollama's — the swap the old dimension check could not see. */
const TWIN = { provider: 'voyage', model: 'voyage-3', dimensions: 1024 };

let orgA: string;
let orgB: string;

async function wipe() {
  // Every partition, not the ones the current naming scheme would produce: a
  // change to that scheme leaves the old ones behind, and this suite counts
  // partitions. Derived names are the wrong thing to clean up by.
  const parts = await raw<{ relname: string }[]>`
    SELECT relname FROM pg_class
    WHERE relname LIKE 'chunk_embeddings\_%' AND relkind = 'r'`;
  for (const p of parts) {
    await raw.unsafe(`DROP TABLE IF EXISTS ${p.relname}`);
  }
  await raw`DELETE FROM embedding_models`;
}

/** Two organisations, because that is the whole point of ADR-005. */
async function twoOrgs() {
  const stamp = Date.now();
  const [a] = await raw<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('A', ${'a' + stamp}) RETURNING id`;
  const [b] = await raw<{ id: string }[]>`
    INSERT INTO organizations (name, slug) VALUES ('B', ${'b' + stamp}) RETURNING id`;
  orgA = a.id;
  orgB = b.id;
}

describe('embedding model catalogue, per organisation', () => {
  beforeEach(async () => {
    await wipe();
    await twoOrgs();
  });
  afterAll(async () => {
    await wipe();
    await raw.end();
  });

  it('the key carries provider, model and dimension — the three that make vectors incomparable', () => {
    expect(modelKeyOf(OLLAMA)).toBe('ollama:mxbai-embed-large@1024');
    // Two models of the SAME dimension get different keys. Comparing only
    // dimensions is what let that swap pass unnoticed before ADR-003.
    expect(modelKeyOf(TWIN)).not.toBe(modelKeyOf(OLLAMA));
  });

  it('the SLOT puts the organisation first, so two orgs never share a partition', () => {
    // The reason this is not cosmetic: an HNSW index shared between a tenant
    // with ten vectors and one with twenty thousand returns the small tenant
    // nothing — its own vector at distance zero included. Measured 0 of 5.
    const a = slotOf(orgA, modelKeyOf(OLLAMA));
    const b = slotOf(orgB, modelKeyOf(OLLAMA));
    expect(a).not.toBe(b);
    expect(partitionNameOf(a)).not.toBe(partitionNameOf(b));
  });

  it("an organisation's first model goes straight to active", async () => {
    const m = await repo.ensureRegistered(orgA, OLLAMA);
    expect(m.state).toBe('active');
    expect(m.orgId).toBe(orgA);
  });

  it('registering the same model again changes nothing', async () => {
    await repo.ensureRegistered(orgA, OLLAMA);
    const again = await repo.ensureRegistered(orgA, OLLAMA);
    expect(again.state).toBe('active');
    expect(await repo.list(orgA)).toHaveLength(1);
  });

  it('a SECOND model in the same org arrives as building — the live one keeps answering', async () => {
    await repo.ensureRegistered(orgA, OLLAMA);
    const next = await repo.ensureRegistered(orgA, AZURE);
    expect(next.state).toBe('building');
    expect((await repo.active(orgA))!.key).toBe(modelKeyOf(OLLAMA));
  });

  it('but the same model in ANOTHER org is that org\'s first, and goes live', async () => {
    await repo.ensureRegistered(orgA, OLLAMA);
    const b = await repo.ensureRegistered(orgB, OLLAMA);
    expect(b.state).toBe('active');
    // Same model, different partitions — that is the design.
    expect(partitionNameOf(b.slot)).not.toBe(partitionNameOf(slotOf(orgA, modelKeyOf(OLLAMA))));
  });

  it('Postgres itself refuses a second active model in one organisation', async () => {
    // The invariant must not depend on this repository behaving: a future
    // caller could otherwise create the state where half an organisation's
    // searches read one vector space and half read another.
    await repo.ensureRegistered(orgA, OLLAMA);
    await repo.ensureRegistered(orgA, AZURE);
    await expect(
      db.execute(sql`UPDATE embedding_models SET state = 'active'
                     WHERE slot = ${slotOf(orgA, modelKeyOf(AZURE))}`),
    ).rejects.toThrow();
    const active = await raw<{ key: string }[]>`
      SELECT key FROM embedding_models WHERE org_id = ${orgA} AND state = 'active'`;
    expect(active.map((r) => r.key)).toEqual([modelKeyOf(OLLAMA)]);
  });

  it('...but not across organisations, which is the point', async () => {
    await repo.ensureRegistered(orgA, OLLAMA);
    await repo.ensureRegistered(orgB, AZURE);
    expect((await repo.active(orgA))!.key).toBe(modelKeyOf(OLLAMA));
    expect((await repo.active(orgB))!.key).toBe(modelKeyOf(AZURE));
  });

  it('each partition pins its dimension, carries an HNSW index, AND its own policy', async () => {
    const m = await repo.ensureRegistered(orgA, OLLAMA);
    const name = partitionNameOf(m.slot);

    const [{ n: indexes }] = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = ${name} AND indexdef ILIKE '%hnsw%'`;
    expect(indexes, 'no HNSW index on the partition').toBe(1);

    const [{ n: checks }] = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = ${name}::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%vector_dims%'`;
    expect(checks, 'the dimension is not pinned').toBe(1);

    // Postgres does NOT inherit RLS to partitions: a policy on the parent
    // protects a query through the parent and nothing else. Measured at
    // 0 rows against 58 before each partition got its own.
    const [{ n: policies }] = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = ${name}::regclass`;
    expect(policies, 'the partition has no policy of its own').toBe(1);
    const [{ forced }] = await raw<{ forced: boolean }[]>`
      SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = ${name}`;
    expect(forced).toBe(true);
  });

  it('every identifier derived from the partition name fits in 63 bytes', () => {
    // Postgres truncates silently. The partition name is a stem — index,
    // constraint and policy names are all built on it — so a name that fits
    // is not enough: an index called `..._hnsw` came out as `..._` and would
    // have collided with any sibling sharing the truncated stem.
    const slot = slotOf(orgA, modelKeyOf({ provider: 'azure', model: 'a'.repeat(200), dimensions: 1536 }));
    const name = partitionNameOf(slot);
    for (const suffix of ['', '_hnsw', '_dim', '_space_member']) {
      expect(
        Buffer.byteLength(name + suffix),
        `${name}${suffix} is ${Buffer.byteLength(name + suffix)} bytes`,
      ).toBeLessThanOrEqual(63);
    }
  });

  it('a long model name still produces a legal, unique partition name', async () => {
    const long = { provider: 'azure', model: 'a'.repeat(120), dimensions: 1536 };
    const other = { provider: 'azure', model: 'a'.repeat(119) + 'b', dimensions: 1536 };
    const n1 = partitionNameOf(slotOf(orgA, modelKeyOf(long)));
    const n2 = partitionNameOf(slotOf(orgA, modelKeyOf(other)));
    expect(n1.length).toBeLessThanOrEqual(63);
    expect(n1).not.toBe(n2);
    await expect(repo.ensureRegistered(orgA, long)).resolves.toBeTruthy();
  });

  describe('activate: the flip, within one organisation', () => {
    it('promotes the new model and retires the previous one', async () => {
      await repo.ensureRegistered(orgA, OLLAMA);
      await repo.ensureRegistered(orgA, AZURE);

      const { previous } = await repo.activate(orgA, slotOf(orgA, modelKeyOf(AZURE)));
      expect(previous).toBe(slotOf(orgA, modelKeyOf(OLLAMA)));
      expect((await repo.active(orgA))!.key).toBe(modelKeyOf(AZURE));
    });

    it('leaves other organisations alone', async () => {
      await repo.ensureRegistered(orgA, OLLAMA);
      await repo.ensureRegistered(orgB, OLLAMA);
      await repo.ensureRegistered(orgA, AZURE);
      await repo.activate(orgA, slotOf(orgA, modelKeyOf(AZURE)));

      expect((await repo.active(orgB))!.key).toBe(modelKeyOf(OLLAMA));
      expect(await repo.list(orgB)).toHaveLength(1);
    });

    it('keeps the retired model so a bad change can be rolled back', async () => {
      await repo.ensureRegistered(orgA, OLLAMA);
      await repo.ensureRegistered(orgA, AZURE);
      await repo.activate(orgA, slotOf(orgA, modelKeyOf(AZURE)));

      const [{ n }] = await raw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class
        WHERE relname = ${partitionNameOf(slotOf(orgA, modelKeyOf(OLLAMA)))}`;
      expect(n).toBe(1);

      await repo.activate(orgA, slotOf(orgA, modelKeyOf(OLLAMA)));
      expect((await repo.active(orgA))!.key).toBe(modelKeyOf(OLLAMA));
    });

    it('never keeps more than two models per organisation, however many changes', async () => {
      const specs = [
        OLLAMA, AZURE, TWIN,
        { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        { provider: 'bedrock', model: 'amazon.titan-embed-text-v2', dimensions: 1024 },
        { provider: 'cohere', model: 'embed-multilingual-v3', dimensions: 1024 },
      ];
      for (const spec of specs) {
        await repo.ensureRegistered(orgA, spec);
        await repo.activate(orgA, slotOf(orgA, modelKeyOf(spec)));
        expect((await repo.list(orgA)).length).toBeLessThanOrEqual(2);
      }

      const models = await repo.list(orgA);
      expect(models).toHaveLength(2);
      expect(models.filter((m) => m.state === 'active')).toHaveLength(1);

      // And the partitions went with them — no orphans left behind.
      const [{ n }] = await raw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class
        WHERE relname LIKE 'chunk_embeddings_%' AND relkind = 'r'`;
      expect(n, 'orphan partitions left behind').toBe(2);
    });

    it('activating the model that is already live is a no-op', async () => {
      await repo.ensureRegistered(orgA, OLLAMA);
      const { previous, dropped } = await repo.activate(orgA, slotOf(orgA, modelKeyOf(OLLAMA)));
      expect(previous).toBe(slotOf(orgA, modelKeyOf(OLLAMA)));
      expect(dropped).toEqual([]);
    });
  });
});
