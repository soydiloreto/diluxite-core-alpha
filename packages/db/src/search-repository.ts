import { and, cosineDistance, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ChunkHit, ChunkToIndex, Fact, SearchRepository, VectorSpace } from '@diluxite/core';
import type { Db } from './client';
import { chunkEmbeddings, chunks, noteLinks, notes, noteTags } from './schema';
import { DrizzleFactsRepository } from './facts-repository';
import { DrizzleEmbeddingModelsRepository } from './embedding-models-repository';

export class DrizzleSearchRepository implements SearchRepository {
  private readonly factsRepo: DrizzleFactsRepository;
  private readonly models: DrizzleEmbeddingModelsRepository;
  private cachedActive: { key: string; dimensions: number } | null = null;
  private readonly registered = new Set<string>();

  constructor(private readonly db: Db) {
    this.factsRepo = new DrizzleFactsRepository(db);
    this.models = new DrizzleEmbeddingModelsRepository(db);
  }

  /**
   * The live model, memoised.
   *
   * Vectors are written to and read from ONE model's partition (ADR-003), so
   * every operation here needs to know which. Cached because it changes once
   * or twice a year and is asked for on every search; `forgetActiveModel()`
   * drops it, which is what a flip calls.
   */
  private async activeModel(space?: VectorSpace): Promise<{ key: string; dimensions: number }> {
    // The caller's own space wins: it is the model that produced the vectors,
    // and reading back from anywhere else compares metres to feet. The
    // catalogue is only consulted when a caller has no embedder to ask —
    // legacy call sites and tests.
    if (space) {
      await this.ensureSpaceRegistered(space);
      return space;
    }
    if (this.cachedActive) return this.cachedActive;
    const row = await this.models.active();
    if (!row) {
      throw new Error(
        'no active embedding model — the instance has not registered one yet (see ADR-003)',
      );
    }
    // `dimensions` is the one value interpolated raw into SQL (a cast needs a
    // literal, not a parameter). It comes from an `integer` column with a
    // CHECK, so it cannot be anything else — asserted here anyway, because the
    // cost is nothing and the class of bug is the expensive kind.
    if (!Number.isInteger(row.dimensions) || row.dimensions <= 0) {
      throw new Error(`embedding model ${row.key} has a non-integer dimension`);
    }
    this.cachedActive = { key: row.key, dimensions: row.dimensions };
    return this.cachedActive;
  }

  /** Called after a model flip so the next query reads the new partition. */
  forgetActiveModel(): void {
    this.cachedActive = null;
  }

  /**
   * A partition must exist before vectors can go into it.
   *
   * Registering here rather than only at boot means an embedder configured
   * after start-up — a test building its own stack, a future runtime switch —
   * writes into its own space instead of failing on a dimension CHECK it never
   * agreed to. Idempotent, and memoised so it costs one round trip per space
   * per process.
   */
  private async ensureSpaceRegistered(space: VectorSpace): Promise<void> {
    if (this.registered.has(space.key)) return;
    const [provider, rest] = space.key.split(':');
    const model = rest?.slice(0, rest.lastIndexOf('@')) ?? 'default';
    await this.models.ensureRegistered({
      provider: provider ?? 'unknown',
      model,
      dimensions: space.dimensions,
    });
    this.registered.add(space.key);
  }

  /**
   * Replace a note's chunks and their vectors.
   *
   * The text goes to `chunks`, the vectors to the live model's partition of
   * `chunk_embeddings` (ADR-003). Deleting the chunks cascades to the vectors,
   * so a re-index cannot leave a stale vector pointing at text that changed.
   */
  async indexChunks(
    noteId: string,
    spaceId: string,
    items: ChunkToIndex[],
    space?: VectorSpace,
  ): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.noteId, noteId));
    if (items.length === 0) return;
    const model = await this.activeModel(space);
    const rows = await this.db
      .insert(chunks)
      .values(
        items.map((c) => ({ noteId, spaceId, text: c.text, position: c.index })),
      )
      .returning({ id: chunks.id, position: chunks.position });

    const byPosition = new Map(rows.map((r) => [r.position, r.id]));
    const vectors = items
      .map((c) => ({ chunkId: byPosition.get(c.index), embedding: c.embedding }))
      .filter((v): v is { chunkId: string; embedding: number[] } => !!v.chunkId);
    if (vectors.length === 0) return;

    await this.db.insert(chunkEmbeddings).values(
      vectors.map((v) => ({
        chunkId: v.chunkId,
        modelKey: model.key,
        spaceId,
        embedding: v.embedding,
      })),
    );
  }

  async removeChunks(noteId: string): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.noteId, noteId));
  }

  async removeTags(noteId: string): Promise<void> {
    await this.db.delete(noteTags).where(eq(noteTags.noteId, noteId));
  }

  async removeLinks(noteId: string): Promise<void> {
    await this.db.delete(noteLinks).where(eq(noteLinks.noteId, noteId));
  }

  async setTags(noteId: string, spaceId: string, tags: string[]): Promise<void> {
    await this.db.delete(noteTags).where(eq(noteTags.noteId, noteId));
    const unique = [...new Set(tags.map((t) => t.toLowerCase()))];
    if (unique.length === 0) return;
    await this.db
      .insert(noteTags)
      .values(unique.map((tag) => ({ noteId, spaceId, tag })))
      .onConflictDoNothing();
  }

  async setLinks(noteId: string, spaceId: string, targets: string[]): Promise<void> {
    await this.db.delete(noteLinks).where(eq(noteLinks.noteId, noteId));
    const unique = [...new Set(targets.map((t) => t.toLowerCase()))];
    if (unique.length === 0) return;
    await this.db
      .insert(noteLinks)
      .values(unique.map((target) => ({ noteId, spaceId, target })))
      .onConflictDoNothing();
  }

  // Keyword search (Spanish FTS, ranked by ts_rank).
  async keywordSearch(spaceId: string, query: string, limit: number): Promise<ChunkHit[]> {
    const tsv = sql`to_tsvector('spanish', ${chunks.text})`;
    const tsq = sql`websearch_to_tsquery('spanish', ${query})`;
    // Join notes + filter trashed so chunks of soft-deleted notes don't burn
    // topK slots (the core post-filters by findById, but dead chunks crowding
    // the candidate set can starve live results out of the limit).
    return this.db
      .select({ id: chunks.id, noteId: chunks.noteId, text: chunks.text })
      .from(chunks)
      .innerJoin(notes, eq(notes.id, chunks.noteId))
      .where(and(eq(chunks.spaceId, spaceId), isNull(notes.deletedAt), sql`${tsv} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${tsv}, ${tsq})`))
      .limit(limit);
  }

  // Vector search (cosine distance; smaller = closer).
  /**
   * Nearest chunks by cosine distance, within the live model's vector space.
   *
   * The `model_key` filter and the cast to the model's dimension are not
   * decoration: together they let the planner prune to that model's partition
   * and use its HNSW index. Without them this is a sequential scan over every
   * vector — 98.6 ms against 4.3 ms at 20k vectors on the machine ADR-003 was
   * measured on.
   *
   * The vector is interpolated as a pgvector LITERAL STRING rather than through
   * `sql.param`, which sends a JS array as separate parameters and fails. It is
   * still a bound parameter — drizzle passes the string as `$n`, it is not
   * spliced into the SQL text. The only value that IS raw is the dimension,
   * because a cast needs a literal; `activeModel()` asserts it is a positive
   * integer before it gets here.
   */
  async vectorSearch(
    spaceId: string,
    embedding: number[],
    limit: number,
    space?: VectorSpace,
  ): Promise<ChunkHit[]> {
    const model = await this.activeModel(space);
    const rows = await this.db.execute<{ id: string; note_id: string; text: string }>(sql`
      SELECT c.id, c.note_id, c.text
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN notes n ON n.id = c.note_id
      WHERE e.model_key = ${model.key}
        AND e.space_id = ${spaceId}
        AND n.deleted_at IS NULL
      ORDER BY e.embedding::vector(${sql.raw(String(model.dimensions))})
               <=> ${`[${embedding.join(',')}]`}::vector(${sql.raw(String(model.dimensions))})
      LIMIT ${limit}`);
    return rows.map((r) => ({ id: r.id, noteId: r.note_id, text: r.text }));
  }

  /**
   * Notes semantically close to a given note (excluding itself). Uses
   * pgvector cosine distance against every chunk of the source, then
   * returns the closest distinct neighbour notes. Useful for the
   * "Neighbors → Suggested" panel in the editor — surfaces notes that
   * are about the same thing even when there is no `[[wikilink]]` yet.
   */
  async relatedToNote(
    spaceId: string,
    noteId: string,
    limit: number,
  ): Promise<{ noteId: string; text: string; distance: number }[]> {
    // Inner query: nearest chunk per neighbour note via DISTINCT ON, keeping
    // the chunk that minimises the cosine distance (`ORDER BY note_id, distance`).
    // We MUST then re-sort by distance and trim in a wrapping query — applying
    // LIMIT directly to the DISTINCT-ON output cut rows in note_id order
    // (≈random), so the closest neighbours could be dropped before `limit`.
    // Trashed notes are excluded by joining `notes` (deleted_at IS NULL).
    const model = await this.activeModel();
    const rows = await this.db.execute<{ note_id: string; text: string; distance: number }>(sql`
      WITH src AS (
        SELECT e.embedding FROM chunk_embeddings e
        JOIN ${chunks} c ON c.id = e.chunk_id
        WHERE c.note_id = ${noteId} AND e.space_id = ${spaceId} AND e.model_key = ${model.key}
      )
      SELECT t.note_id, t.text, t.distance
      FROM (
        SELECT DISTINCT ON (c.note_id)
          c.note_id AS note_id, c.text AS text,
          (e.embedding <=> s.embedding) AS distance
        FROM chunk_embeddings e
        JOIN ${chunks} c ON c.id = e.chunk_id
        JOIN ${notes} n ON n.id = c.note_id
        CROSS JOIN src s
        WHERE e.space_id = ${spaceId}
          AND e.model_key = ${model.key}
          AND c.note_id <> ${noteId}
          AND n.deleted_at IS NULL
        ORDER BY c.note_id, distance ASC
      ) t
      ORDER BY t.distance ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ noteId: r.note_id, text: r.text, distance: Number(r.distance) }));
  }

  /**
   * Replace a note's derived facts (ADR-001 step 2). Delegates to the facts
   * repository so the derivation has one home, while the indexer keeps a
   * single port to talk to.
   */
  async setFacts(noteId: string, spaceId: string, rows: Fact[]): Promise<void> {
    await this.factsRepo.replaceForNote(noteId, spaceId, rows);
  }

  async removeFacts(noteId: string): Promise<void> {
    await this.factsRepo.removeForNote(noteId);
  }

  /**
   * What is actually stored, by embedding model — ADR-003.
   *
   * Reported per MODEL, not per dimension. Two models can share a dimension,
   * and the version of this that grouped by `vector_dims` called that state
   * healthy while search returned nonsense.
   *
   * `chunksWithoutEmbedding` counts chunks the live model has no vector for:
   * a provider that was down while notes were saved leaves them behind, and a
   * newly registered model has all of them until a reindex runs.
   */
  async embeddingStats(): Promise<EmbeddingStats> {
    const models = await this.models.list();
    const active = models.find((m) => m.state === 'active') ?? null;
    const counts = await this.models.counts();
    const byKey = new Map(counts.map((c) => [c.key, c.chunks]));

    const stored = models.map((m) => ({
      key: m.key,
      provider: m.provider,
      model: m.model,
      dimensions: m.dimensions,
      state: m.state,
      chunks: byKey.get(m.key) ?? 0,
    }));

    const total = await this.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM chunks`);
    const chunks = Number(total[0]?.n ?? 0);
    const withActive = active ? (byKey.get(active.key) ?? 0) : 0;
    return {
      stored,
      chunks,
      chunksWithoutEmbedding: Math.max(0, chunks - withActive),
    };
  }
}

export interface EmbeddingStats {
  /** One entry per registered model: normally one, briefly two during a change. */
  stored: {
    key: string;
    provider: string;
    model: string;
    dimensions: number;
    state: string;
    chunks: number;
  }[];
  /** Chunks the ACTIVE model has no vector for — what a reindex would fix. */
  chunksWithoutEmbedding: number;
  chunks: number;
}
