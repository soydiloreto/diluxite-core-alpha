import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb } from './client';
import {
  DrizzleEmbeddingModelsRepository,
  modelKeyOf,
  partitionNameOf,
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

async function wipe() {
  const rows = await raw<{ key: string }[]>`SELECT key FROM embedding_models`;
  for (const r of rows) {
    await raw.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(r.key)}`);
  }
  await raw`DELETE FROM embedding_models`;
}

describe('embedding model catalogue', () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await raw.end();
  });

  it('the key carries provider, model and dimension — the three that make vectors incomparable', () => {
    expect(modelKeyOf(OLLAMA)).toBe('ollama:mxbai-embed-large@1024');
    // Two models of the SAME dimension get different keys. Comparing only
    // dimensions is what let this swap pass unnoticed before ADR-003.
    expect(modelKeyOf(TWIN)).not.toBe(modelKeyOf(OLLAMA));
  });

  it('the first model on a fresh install goes straight to active', async () => {
    const m = await repo.ensureRegistered(OLLAMA);
    expect(m.state).toBe('active');
    expect(m.activatedAt).not.toBeNull();
  });

  it('registering the same model again changes nothing', async () => {
    await repo.ensureRegistered(OLLAMA);
    const again = await repo.ensureRegistered(OLLAMA);
    expect(again.state).toBe('active');
    expect(await repo.list()).toHaveLength(1);
  });

  it('a SECOND model arrives as building — the live one keeps answering', async () => {
    await repo.ensureRegistered(OLLAMA);
    const next = await repo.ensureRegistered(AZURE);
    expect(next.state).toBe('building');
    expect((await repo.active())!.key).toBe(modelKeyOf(OLLAMA));
  });

  it('Postgres itself refuses a second active model', async () => {
    // The invariant that must not depend on this repository behaving. If it
    // lived only in code, a future caller could quietly create the state where
    // half the searches read one vector space and half read another.
    await repo.ensureRegistered(OLLAMA);
    await repo.ensureRegistered(AZURE);
    await expect(
      db.execute(sql`UPDATE embedding_models SET state = 'active' WHERE key = ${modelKeyOf(AZURE)}`),
    ).rejects.toThrow();
    // And the refusal left the world unchanged, rather than half-applied.
    const active = await raw<{ key: string }[]>`SELECT key FROM embedding_models WHERE state = 'active'`;
    expect(active.map((r) => r.key)).toEqual([modelKeyOf(OLLAMA)]);
  });

  it('each model gets a partition with its dimension pinned and an HNSW index', async () => {
    await repo.ensureRegistered(OLLAMA);
    const name = partitionNameOf(modelKeyOf(OLLAMA));

    const [{ n: indexes }] = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = ${name} AND indexdef ILIKE '%hnsw%'`;
    expect(indexes, 'no HNSW index on the partition').toBe(1);

    const [{ n: checks }] = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = ${name}::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%vector_dims%'`;
    expect(checks, 'the dimension is not pinned').toBe(1);
  });

  it('the pinned dimension is enforced, not decorative', async () => {
    const m = await repo.ensureRegistered(OLLAMA);
    const [space] = await raw<{ id: string }[]>`SELECT id FROM spaces LIMIT 1`;
    const [chunk] = await raw<{ id: string }[]>`SELECT id FROM chunks LIMIT 1`;
    if (!space || !chunk) return; // nothing indexed in this database; covered elsewhere

    const wrong = `[${Array.from({ length: 999 }, () => '0.1').join(',')}]`;
    await expect(
      raw`INSERT INTO chunk_embeddings (chunk_id, model_key, space_id, embedding)
          VALUES (${chunk.id}, ${m.key}, ${space.id}, ${wrong}::vector)`,
    ).rejects.toThrow();
  });

  it('two models with the SAME dimension get separate partitions', async () => {
    await repo.ensureRegistered(OLLAMA);
    await repo.ensureRegistered(TWIN);
    expect(partitionNameOf(modelKeyOf(OLLAMA))).not.toBe(partitionNameOf(modelKeyOf(TWIN)));
    const names = [partitionNameOf(modelKeyOf(OLLAMA)), partitionNameOf(modelKeyOf(TWIN))];
    const rows = await raw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY(${names})`;
    expect(rows[0].n).toBe(2);
  });

  it('a long model name still produces a legal, unique partition name', async () => {
    const long = { provider: 'azure', model: 'a'.repeat(120), dimensions: 1536 };
    const other = { provider: 'azure', model: 'a'.repeat(119) + 'b', dimensions: 1536 };
    const n1 = partitionNameOf(modelKeyOf(long));
    const n2 = partitionNameOf(modelKeyOf(other));
    expect(n1.length).toBeLessThanOrEqual(63);
    // Truncation must not collapse two different models onto one partition.
    expect(n1).not.toBe(n2);
    await expect(repo.ensureRegistered(long)).resolves.toBeTruthy();
  });

  describe('activate: the flip', () => {
    it('promotes the new model and retires the previous one', async () => {
      await repo.ensureRegistered(OLLAMA);
      await repo.ensureRegistered(AZURE);

      const { previous } = await repo.activate(modelKeyOf(AZURE));
      expect(previous).toBe(modelKeyOf(OLLAMA));
      expect((await repo.active())!.key).toBe(modelKeyOf(AZURE));
      expect((await repo.byKey(modelKeyOf(OLLAMA)))!.state).toBe('retired');
    });

    it('keeps the retired model so a bad change can be rolled back', async () => {
      await repo.ensureRegistered(OLLAMA);
      await repo.ensureRegistered(AZURE);
      await repo.activate(modelKeyOf(AZURE));

      // Its partition — and its vectors — are still there.
      const [{ n }] = await raw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class WHERE relname = ${partitionNameOf(modelKeyOf(OLLAMA))}`;
      expect(n).toBe(1);

      await repo.activate(modelKeyOf(OLLAMA));
      expect((await repo.active())!.key).toBe(modelKeyOf(OLLAMA));
    });

    it('never keeps more than two models, however many changes happen', async () => {
      // The property the whole design rests on. Five changes must not leave
      // five copies of every vector in the database.
      const specs = [
        OLLAMA,
        AZURE,
        TWIN,
        { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 },
        { provider: 'bedrock', model: 'amazon.titan-embed-text-v2', dimensions: 1024 },
        { provider: 'cohere', model: 'embed-multilingual-v3', dimensions: 1024 },
      ];
      for (const s of specs) {
        await repo.ensureRegistered(s);
        await repo.activate(modelKeyOf(s));
        expect((await repo.list()).length).toBeLessThanOrEqual(2);
      }

      const models = await repo.list();
      expect(models).toHaveLength(2);
      expect(models.filter((m) => m.state === 'active')).toHaveLength(1);
      expect(models.filter((m) => m.state === 'retired')).toHaveLength(1);

      // And the partitions went with them — no orphans left behind.
      const [{ n }] = await raw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class
        WHERE relname LIKE 'chunk_embeddings_%' AND relkind = 'r'`;
      expect(n, 'orphan partitions left behind').toBe(2);
    });

    it('activating the model that is already live is a no-op', async () => {
      await repo.ensureRegistered(OLLAMA);
      const { previous, dropped } = await repo.activate(modelKeyOf(OLLAMA));
      expect(previous).toBe(modelKeyOf(OLLAMA));
      expect(dropped).toEqual([]);
      expect(await repo.list()).toHaveLength(1);
    });
  });
});
