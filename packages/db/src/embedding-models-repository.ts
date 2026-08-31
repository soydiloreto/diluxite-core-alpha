import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * The embedding model catalogue — ADR-003.
 *
 * One model is live at a time, and Postgres enforces it: a partial unique
 * index on `state = 'active'` refuses a second one. A model change is a
 * bounded migration (build alongside → flip → drop the old), not an edit.
 *
 * Every model owns one partition of `chunk_embeddings`, with its dimension
 * pinned and an ordinary HNSW index. Creating and dropping those partitions is
 * DDL executed from the application, which is unusual enough to justify: it is
 * the only way to give each model a real index while a change is in flight,
 * and it happens exactly twice in a model's life — when it is registered and
 * when it is retired.
 */

export type EmbeddingModelState = 'active' | 'building' | 'retired';

export interface EmbeddingModelRow extends Record<string, unknown> {
  key: string;
  provider: string;
  model: string;
  dimensions: number;
  state: EmbeddingModelState;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export interface EmbeddingModelSpec {
  provider: string;
  /** Deployment or model name; `null` for the deterministic fallback. */
  model: string | null;
  dimensions: number;
}

/**
 * The identity of a vector space, as a string.
 *
 * Provider, model and dimension, because those three are what make two
 * vectors incomparable. Comparing only dimensions is what let a swap between
 * two 1024-dimension models pass unnoticed.
 */
export function modelKeyOf(spec: EmbeddingModelSpec): string {
  return `${spec.provider}:${spec.model ?? 'default'}@${spec.dimensions}`;
}

/**
 * A partition name derived from the key.
 *
 * Postgres identifiers cap at 63 bytes and a model key can be longer than
 * that (an Azure deployment name is arbitrary), so the readable prefix is
 * truncated and disambiguated with a hash of the FULL key. Two different
 * models can therefore never collide on a partition, however similar their
 * names.
 */
export function partitionNameOf(key: string): string {
  // The trim is a character scan rather than `/^_+|_+$/`, which CodeQL flags
  // as polynomial backtracking. Measured, the alert is a false positive twice
  // over: that regex runs in 0.1 ms on 160k underscores, and the collapse
  // above can never hand it a run longer than one anyway. The scan ships
  // regardless — it needs no such reasoning to be obviously linear, and
  // arguing with a scanner costs more than not giving it anything to say.
  const collapsed = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '_') start += 1;
  while (end > start && collapsed[end - 1] === '_') end -= 1;
  const slug = collapsed.slice(start, end);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 8);
  // 17 ("chunk_embeddings_") + 36 + 1 + 8 = 62, under Postgres's 63-byte cap.
  return `chunk_embeddings_${slug.slice(0, 36)}_${digest}`;
}

export class DrizzleEmbeddingModelsRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<EmbeddingModelRow[]> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT key, provider, model, dimensions, state,
             created_at AS "createdAt", activated_at AS "activatedAt", retired_at AS "retiredAt"
      FROM embedding_models
      ORDER BY created_at DESC`);
    return [...rows];
  }

  async active(): Promise<EmbeddingModelRow | null> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT key, provider, model, dimensions, state,
             created_at AS "createdAt", activated_at AS "activatedAt", retired_at AS "retiredAt"
      FROM embedding_models WHERE state = 'active' LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * Make `spec` the live model, creating whatever it needs.
   *
   * Idempotent: called on every boot with whatever the environment configured.
   * The common case — same model as last time — is one SELECT.
   *
   * A DIFFERENT model here is a boot-time change of the vector space, which
   * this method deliberately does NOT resolve on its own: it registers the new
   * model as `building` and leaves the old one live, so search keeps answering
   * while the backfill runs. Promoting it is `activate()`.
   */
  async ensureRegistered(spec: EmbeddingModelSpec): Promise<EmbeddingModelRow> {
    const key = modelKeyOf(spec);
    const existing = await this.byKey(key);
    if (existing) {
      // A retired model coming back — the rollback case — returns to building
      // rather than straight to active, so its partition is verified first.
      if (existing.state === 'retired') {
        await this.db.execute(sql`
          UPDATE embedding_models SET state = 'building', retired_at = NULL WHERE key = ${key}`);
        await this.ensurePartition(key, spec.dimensions);
        return (await this.byKey(key))!;
      }
      await this.ensurePartition(key, spec.dimensions);
      return existing;
    }

    // First model on a fresh installation becomes active immediately: there is
    // nothing to keep serving, so a 'building' state would only mean an
    // instance that cannot search until someone flips it.
    const hasActive = (await this.active()) !== null;
    await this.db.execute(sql`
      INSERT INTO embedding_models (key, provider, model, dimensions, state, activated_at)
      VALUES (${key}, ${spec.provider}, ${spec.model ?? 'default'}, ${spec.dimensions},
              ${hasActive ? 'building' : 'active'}, ${hasActive ? null : sql`now()`})
      ON CONFLICT (key) DO NOTHING`);
    await this.ensurePartition(key, spec.dimensions);
    return (await this.byKey(key))!;
  }

  async byKey(key: string): Promise<EmbeddingModelRow | null> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT key, provider, model, dimensions, state,
             created_at AS "createdAt", activated_at AS "activatedAt", retired_at AS "retiredAt"
      FROM embedding_models WHERE key = ${key} LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * Whether this model is registered AND its partition exists.
   *
   * Pure reads. It exists so the write path can tell "already set up" from
   * "needs DDL" without attempting DDL, which under the unprivileged data-plane
   * role (ADR-004) would fail — correctly, since registering a model is a boot
   * or admin action, not something a note save should be doing.
   */
  async isReady(key: string): Promise<boolean> {
    const rows = await this.db.execute<{ ready: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM embedding_models WHERE key = ${key})
         AND to_regclass(${partitionNameOf(key)}) IS NOT NULL AS ready`);
    return rows[0]?.ready === true;
  }

  /**
   * The partition for a model, plus its index. Safe to call repeatedly.
   *
   * The CHECK is what lets the index exist: pgvector needs a fixed dimension,
   * and the parent column deliberately has none so that two models can hold
   * different ones during a change.
   */
  async ensurePartition(key: string, dimensions: number): Promise<string> {
    const name = partitionNameOf(key);
    await this.db.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS ${name}
        PARTITION OF chunk_embeddings FOR VALUES IN ('${key.replace(/'/g, "''")}')`),
    );
    await this.db.execute(
      sql.raw(`
      DO $$ BEGIN
        ALTER TABLE ${name} ADD CONSTRAINT ${name}_dim
          CHECK (vector_dims(embedding) = ${dimensions});
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`),
    );
    // HNSW over cosine distance: the same index a single-model schema would
    // have. Built concurrently is not possible inside a transaction, and this
    // runs at boot on an empty or small partition, so a plain build is right.
    await this.db.execute(
      sql.raw(`
      CREATE INDEX IF NOT EXISTS ${name}_hnsw ON ${name}
        USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)`),
    );

    // THE PARTITION NEEDS ITS OWN POLICY. Postgres does not inherit RLS to
    // partitions: a policy on `chunk_embeddings` protects queries that go
    // through the parent and does NOTHING for a query naming the partition.
    // Measured before this line existed — the parent returned 0 rows without
    // an identity and the partition returned all 58.
    //
    // Nothing queries partitions by name today, and what does (this DDL, the
    // retirement DROP) runs privileged. But "nothing does yet" is not a
    // security property, and several organisations will share a partition
    // whenever they choose the same model.
    await this.db.execute(sql.raw(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`));
    await this.db.execute(sql.raw(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`));
    await this.db.execute(sql.raw(`DROP POLICY IF EXISTS ${name}_space_member ON ${name}`));
    await this.db.execute(
      sql.raw(`
      CREATE POLICY ${name}_space_member ON ${name}
        USING (diluxite_can_access_space(space_id, diluxite_current_user_id()))`),
    );
    return name;
  }

  /**
   * Promote `key` to live, demote the previous one, and drop anything older.
   *
   * All of it in ONE transaction. The drop is the part that matters: it is not
   * a cleanup job and not a button, so it cannot be skipped. Five model changes
   * leave two models; fifty leave two.
   */
  async activate(key: string): Promise<{ previous: string | null; dropped: string[] }> {
    return this.db.transaction(async (tx) => {
      const current = await tx.execute<{ key: string }>(sql`
        SELECT key FROM embedding_models WHERE state = 'active' LIMIT 1`);
      const previous = current[0]?.key ?? null;
      if (previous === key) return { previous, dropped: [] };

      // Anything already retired is now two changes old: it can go. EXCEPT
      // the model being activated — rolling back promotes a retired model, and
      // an earlier version of this swept away the partition it had just made
      // live. The test for rollback is what caught it.
      const stale = await tx.execute<{ key: string }>(sql`
        SELECT key FROM embedding_models WHERE state = 'retired' AND key <> ${key}`);

      if (previous) {
        await tx.execute(sql`
          UPDATE embedding_models SET state = 'retired', retired_at = now() WHERE key = ${previous}`);
      }
      await tx.execute(sql`
        UPDATE embedding_models SET state = 'active', activated_at = now(), retired_at = NULL
        WHERE key = ${key}`);

      for (const row of stale) {
        await tx.execute(sql.raw(`DROP TABLE IF EXISTS ${partitionNameOf(row.key)}`));
        await tx.execute(sql`DELETE FROM embedding_models WHERE key = ${row.key}`);
      }
      return { previous, dropped: stale.map((r) => r.key) };
    });
  }

  /** How many vectors each model holds — what a health panel reports. */
  async counts(): Promise<{ key: string; chunks: number }[]> {
    const rows = await this.db.execute<{ key: string; chunks: string }>(sql`
      SELECT m.key, count(e.chunk_id) AS chunks
      FROM embedding_models m
      LEFT JOIN chunk_embeddings e ON e.model_key = m.key
      GROUP BY m.key`);
    return rows.map((r) => ({ key: r.key, chunks: Number(r.chunks) }));
  }

  /**
   * Copy vectors from the pre-ADR-003 `chunks.embedding` column into the
   * active model's partition, once.
   *
   * Only rows whose dimension matches: an installation that changed models
   * before this existed can hold vectors of two shapes in that column, and the
   * ones that do not match the live model were already unusable. They are left
   * behind rather than crashing the boot, and a reindex rebuilds them.
   */
  async backfillFromChunks(key: string, dimensions: number): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      WITH moved AS (
        INSERT INTO chunk_embeddings (chunk_id, model_key, space_id, embedding)
        SELECT c.id, ${key}, c.space_id, c.embedding
        FROM chunks c
        WHERE c.embedding IS NOT NULL
          AND vector_dims(c.embedding) = ${dimensions}
        ON CONFLICT (chunk_id, model_key) DO NOTHING
        RETURNING 1
      )
      SELECT count(*) AS n FROM moved`);
    return Number(rows[0]?.n ?? 0);
  }
}
