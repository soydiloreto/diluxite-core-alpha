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
  /** The organisation this model is live for — ADR-005. */
  orgId: string;
  /** `"<org_id>:<key>"` — the partition key. */
  slot: string;
  provider: string;
  model: string;
  dimensions: number;
  state: EmbeddingModelState;
  /**
   * How to reach the provider that produced these vectors — migration 0034.
   *
   * On the ROW and not only in `embedding_config` because that table holds one
   * current choice per organisation: the moment somebody picks a new model,
   * the description of the old one is gone, and the old one is precisely what
   * still has to answer queries while the new space is being built.
   *
   * `null` means "whatever the organisation's configuration says", which is
   * every row that existed before this column did.
   */
  endpoint: string | null;
  /** Sealed with DILUXITE_SECRET_KEY. Never leaves the server. */
  apiKeySealed: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export interface EmbeddingModelSpec {
  provider: string;
  /** Deployment or model name; `null` for the deterministic fallback. */
  model: string | null;
  dimensions: number;
  /**
   * Where this provider lives, and the sealed key for it. Optional: a caller
   * that has neither — a local provider, a test double — registers a model
   * that describes itself as "no endpoint, no key", which is the truth.
   */
  endpoint?: string | null;
  apiKeySealed?: string | null;
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
 * The partition an organisation's vectors live in — ADR-005.
 *
 * Organisation FIRST, so two organisations on the same model never share one.
 * That is not tidiness: an HNSW index shared between a tenant with ten vectors
 * and one with twenty thousand returns the small tenant nothing, because the
 * index's nearest candidates all belong to the large one and the tenant filter
 * removes every one of them. Measured at 0 of 5 against 5 of 5.
 */
export function slotOf(orgId: string, key: string): string {
  return `${orgId}:${key}`;
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
export function partitionNameOf(slot: string): string {
  // The trim is a character scan rather than `/^_+|_+$/`, which CodeQL flags
  // as polynomial backtracking. Measured, the alert is a false positive twice
  // over: that regex runs in 0.1 ms on 160k underscores, and the collapse
  // above can never hand it a run longer than one anyway. The scan ships
  // regardless — it needs no such reasoning to be obviously linear, and
  // arguing with a scanner costs more than not giving it anything to say.
  const collapsed = slot.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '_') start += 1;
  while (end > start && collapsed[end - 1] === '_') end -= 1;
  const slug = collapsed.slice(start, end);
  const digest = createHash('sha256').update(slot).digest('hex').slice(0, 8);
  // Postgres truncates identifiers at 63 bytes SILENTLY, and this name is a
  // stem: everything derived from it must fit too. The longest suffix is
  // `_space_member` (13), so the name itself is capped at 48:
  //   17 ("chunk_embeddings_") + 22 (slug) + 1 + 8 (digest) = 48, + 13 = 61.
  //
  // Measured the hard way: at 62 the index came out named `..._` with the
  // `hnsw` cut off, which still worked and would have collided the moment two
  // partitions shared a truncated stem. The test that asserts the planner
  // uses an index called `*hnsw*` is what caught it.
  return `chunk_embeddings_${slug.slice(0, 22)}_${digest}`;
}

export class DrizzleEmbeddingModelsRepository {
  constructor(private readonly db: Db) {}

  private readonly columns = sql`
      key, org_id AS "orgId", slot, provider, model, dimensions, state,
      endpoint, api_key_sealed AS "apiKeySealed",
      created_at AS "createdAt", activated_at AS "activatedAt", retired_at AS "retiredAt"`;

  /** Every model this organisation has ever had. Normally one, briefly two. */
  async list(orgId: string): Promise<EmbeddingModelRow[]> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT ${this.columns} FROM embedding_models WHERE org_id = ${orgId}
      ORDER BY created_at DESC`);
    return [...rows];
  }

  /** The model this organisation searches with. */
  async active(orgId: string): Promise<EmbeddingModelRow | null> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT ${this.columns} FROM embedding_models
      WHERE org_id = ${orgId} AND state = 'active' LIMIT 1`);
    return rows[0] ?? null;
  }

  async bySlot(slot: string): Promise<EmbeddingModelRow | null> {
    const rows = await this.db.execute<EmbeddingModelRow>(sql`
      SELECT ${this.columns} FROM embedding_models WHERE slot = ${slot} LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * Make `spec` this organisation's model, creating whatever it needs.
   *
   * Idempotent: called on every boot and on every save from the console. A
   * DIFFERENT model registers as `building` and does NOT take over — the
   * organisation keeps searching with the model that has vectors until a
   * reindex fills the new one.
   */
  async ensureRegistered(orgId: string, spec: EmbeddingModelSpec): Promise<EmbeddingModelRow> {
    const key = modelKeyOf(spec);
    const slot = slotOf(orgId, key);
    const existing = await this.bySlot(slot);
    if (existing) {
      // A retired model coming back — the rollback case — returns to building
      // rather than straight to active, so its partition is verified first.
      if (existing.state === 'retired') {
        await this.db.execute(sql`
          UPDATE embedding_models SET state = 'building', retired_at = NULL WHERE slot = ${slot}`);
      }
      // The endpoint and the key are refreshed on every registration, because
      // they are the one part of a model that legitimately changes without the
      // model changing: moving an Ollama instance or rotating a key is 48a,
      // and the vectors already stored stay perfectly valid.
      if (spec.endpoint !== undefined || spec.apiKeySealed !== undefined) {
        await this.db.execute(sql`
          UPDATE embedding_models
          SET endpoint = ${spec.endpoint ?? null}, api_key_sealed = ${spec.apiKeySealed ?? null}
          WHERE slot = ${slot}`);
      }
      await this.ensurePartition(slot, spec.dimensions);
      return (await this.bySlot(slot))!;
    }

    // The organisation's first model goes live immediately: there is nothing
    // to keep serving, and a `building` state would only mean an organisation
    // that cannot search until somebody flips it.
    const hasActive = (await this.active(orgId)) !== null;
    await this.db.execute(sql`
      INSERT INTO embedding_models (key, org_id, slot, provider, model, dimensions, state,
                                    endpoint, api_key_sealed, activated_at)
      VALUES (${key}, ${orgId}, ${slot}, ${spec.provider}, ${spec.model ?? 'default'},
              ${spec.dimensions}, ${hasActive ? 'building' : 'active'},
              ${spec.endpoint ?? null}, ${spec.apiKeySealed ?? null},
              ${hasActive ? null : sql`now()`})
      ON CONFLICT (slot) DO NOTHING`);
    await this.ensurePartition(slot, spec.dimensions);
    return (await this.bySlot(slot))!;
  }

  /**
   * Whether this slot is registered AND its partition exists.
   *
   * Pure reads, so the write path can tell "already set up" from "needs DDL"
   * without attempting DDL — which under the unprivileged data-plane role
   * (ADR-004) would fail, correctly: registering a model is a boot or admin
   * action, not something a note save should be doing.
   */
  async isReady(slot: string): Promise<boolean> {
    const rows = await this.db.execute<{ ready: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM embedding_models WHERE slot = ${slot})
         AND to_regclass(${partitionNameOf(slot)}) IS NOT NULL AS ready`);
    return rows[0]?.ready === true;
  }

  /**
   * The partition for a slot, its pinned dimension, its index, and its policy.
   *
   * THE POLICY IS NOT OPTIONAL. Postgres does not inherit RLS to partitions: a
   * policy on `chunk_embeddings` protects a query that goes through the parent
   * and does nothing for one that names the partition. Measured at 0 rows
   * against 58 before this existed. Nothing queries partitions by name today,
   * and what does runs privileged — but "nothing does yet" is not a security
   * property.
   */
  async ensurePartition(slot: string, dimensions: number): Promise<string> {
    const name = partitionNameOf(slot);
    const literal = slot.replace(/'/g, "''");
    await this.db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${name}
        PARTITION OF chunk_embeddings FOR VALUES IN ('${literal}')`),
    );
    await this.db.execute(
      sql.raw(`DO $$ BEGIN
        ALTER TABLE ${name} ADD CONSTRAINT ${name}_dim
          CHECK (vector_dims(embedding) = ${dimensions});
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`),
    );
    await this.db.execute(
      sql.raw(`CREATE INDEX IF NOT EXISTS ${name}_hnsw ON ${name}
        USING hnsw ((embedding::vector(${dimensions})) vector_cosine_ops)`),
    );
    await this.db.execute(sql.raw(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`));
    await this.db.execute(sql.raw(`ALTER TABLE ${name} FORCE ROW LEVEL SECURITY`));
    await this.db.execute(sql.raw(`DROP POLICY IF EXISTS ${name}_space_member ON ${name}`));
    await this.db.execute(
      sql.raw(`CREATE POLICY ${name}_space_member ON ${name}
        USING (diluxite_can_access_space(space_id, diluxite_current_user_id()))`),
    );
    return name;
  }

  /**
   * Promote a slot to live for its organisation, retire the previous one, and
   * drop anything older — all in ONE transaction.
   *
   * The drop is the part that matters: not a cleanup job and not a button, so
   * it cannot be skipped. Five model changes leave two models per
   * organisation; fifty leave two.
   */
  async activate(orgId: string, slot: string): Promise<{ previous: string | null; dropped: string[] }> {
    return this.db.transaction(async (tx) => {
      const current = await tx.execute<{ slot: string }>(sql`
        SELECT slot FROM embedding_models WHERE org_id = ${orgId} AND state = 'active' LIMIT 1`);
      const previous = current[0]?.slot ?? null;
      if (previous === slot) return { previous, dropped: [] };

      // Retired models of THIS organisation only, and never the one being
      // activated — rolling back promotes a retired model, and an earlier
      // version of this swept away the partition it had just made live.
      const stale = await tx.execute<{ slot: string }>(sql`
        SELECT slot FROM embedding_models
        WHERE org_id = ${orgId} AND state = 'retired' AND slot <> ${slot}`);

      if (previous) {
        await tx.execute(sql`
          UPDATE embedding_models SET state = 'retired', retired_at = now() WHERE slot = ${previous}`);
      }
      await tx.execute(sql`
        UPDATE embedding_models SET state = 'active', activated_at = now(), retired_at = NULL
        WHERE slot = ${slot}`);

      for (const row of stale) {
        await tx.execute(sql.raw(`DROP TABLE IF EXISTS ${partitionNameOf(row.slot)}`));
        await tx.execute(sql`DELETE FROM embedding_models WHERE slot = ${row.slot}`);
      }
      return { previous, dropped: stale.map((r) => r.slot) };
    });
  }

  /** How many vectors each of this organisation's models holds. */
  async counts(orgId: string): Promise<{ slot: string; chunks: number }[]> {
    const rows = await this.db.execute<{ slot: string; chunks: string }>(sql`
      SELECT m.slot, count(e.chunk_id) AS chunks
      FROM embedding_models m
      LEFT JOIN chunk_embeddings e ON e.slot = m.slot
      WHERE m.org_id = ${orgId}
      GROUP BY m.slot`);
    return rows.map((r) => ({ slot: r.slot, chunks: Number(r.chunks) }));
  }

  /**
   * Copy vectors from the pre-ADR-003 `chunks.embedding` column into a slot,
   * once.
   *
   * Only rows of the right organisation and the right dimension: an
   * installation that changed models before this existed can hold vectors of
   * two shapes in that column, and the ones that do not match were already
   * unusable. They are left behind rather than crashing the boot, and a
   * reindex rebuilds them.
   */
  async backfillFromChunks(orgId: string, slot: string, dimensions: number): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(sql`
      WITH moved AS (
        INSERT INTO chunk_embeddings (chunk_id, slot, org_id, space_id, embedding)
        SELECT c.id, ${slot}, ${orgId}, c.space_id, c.embedding
        FROM chunks c
        JOIN spaces s ON s.id = c.space_id
        WHERE c.embedding IS NOT NULL
          AND s.org_id = ${orgId}
          AND vector_dims(c.embedding) = ${dimensions}
        ON CONFLICT (chunk_id, slot) DO NOTHING
        RETURNING 1
      )
      SELECT count(*) AS n FROM moved`);
    return Number(rows[0]?.n ?? 0);
  }
}
