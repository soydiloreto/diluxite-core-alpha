import { chunkMarkdown } from './chunking';
import { ftsConfigFor } from './language';
import { parseTags } from './tags';
import { factsOf, type Fact } from './facts';
import { uniqueTargets } from './wikilinks';
import { reciprocalRankFusion } from './rrf';
import { LexicalReranker } from './reranker';
import type { EmbeddingProvider, Reranker } from './providers';
import type { Note, NoteIndexer, NotesRepository } from './notes';
import {
  assessStaleness,
  structuralKindOf,
  type ChangeCadence,
  type StalenessAssessment,
} from './staleness';

export interface ChunkHit {
  id: string;
  noteId: string;
  text: string;
}

/**
 * Which vector space a set of embeddings lives in — ADR-003.
 *
 * Derived from the embedder that made them, so a search reads back from the
 * same space it wrote into. `dimensions` travels with the key because the
 * pgvector cast that lets the index be used needs a literal.
 */
export interface VectorSpace {
  /** `"<org_id>:<provider:model@dims>"` — the partition an org's vectors live in. */
  slot: string;
  /** The organisation. Vectors of two organisations never share a partition. */
  orgId: string;
  dimensions: number;
}

/**
 * A vector space plus how to embed for it — the catalogue row, in the shape
 * the service needs (migration 0034).
 *
 * The credentials travel with the SPACE because a query has to be embedded by
 * the model that produced the vectors it is searching. While a new model is
 * being built, that is not the model the organisation is configured with.
 */
export interface VectorSpaceModel extends VectorSpace {
  state: 'active' | 'building';
  provider: string;
  model: string | null;
  endpoint: string | null;
  apiKeySealed: string | null;
}

export interface ChunkToIndex {
  text: string;
  index: number;
  embedding: number[];
  /**
   * The Postgres text-search configuration this chunk should be indexed with
   * — 'english', 'portuguese', … Set from the language detected in the note.
   * Optional so an in-memory double need not care; the store then falls back
   * to its own default, which is what every chunk written before languages
   * existed carries.
   */
  ftsConfig?: string;
}

/** Search port (Postgres FTS + pgvector in @diluxite/db). */
export interface SearchRepository {
  /**
   * `space` identifies the VECTOR SPACE the embeddings belong to (ADR-003) —
   * the model that produced them, not whichever model a flag calls active.
   * Vectors from two models are not comparable, so writing them under the
   * wrong key is worse than not writing them at all.
   */
  indexChunks(
    noteId: string,
    spaceId: string,
    chunks: ChunkToIndex[],
    space?: VectorSpace,
    /**
     * The other spaces these same chunks belong in — the blue/green dual write.
     *
     * While a model change is in flight the organisation has two vector
     * spaces: the one answering queries and the one being filled. Writing only
     * the second is what left an `active` model with an empty partition and
     * nothing to roll back to; writing both keeps the flip reversible, which
     * is the entire point of building alongside.
     */
    also?: { space: VectorSpace; embeddings: number[][] }[],
  ): Promise<void>;

  /**
   * The organisation's vector spaces: the live one and any being built.
   *
   * Optional: a repository without it (an in-memory double) puts the service
   * back on "one organisation, one space", which is what every installation
   * looks like until somebody changes the model.
   */
  modelsOf?(orgId: string): Promise<VectorSpaceModel[]>;
  removeChunks(noteId: string): Promise<void>;
  setTags(noteId: string, spaceId: string, tags: string[]): Promise<void>;
  setLinks(noteId: string, spaceId: string, targets: string[]): Promise<void>;
  /**
   * Replace the note's derived facts (ADR-001 step 2). Optional so in-memory
   * doubles need not implement it; a deployment without it simply has no
   * factual lane, rather than a lane that answers from nothing.
   */
  setFacts?(noteId: string, spaceId: string, rows: Fact[]): Promise<void>;
  removeFacts?(noteId: string): Promise<void>;
  removeTags(noteId: string): Promise<void>;
  removeLinks(noteId: string): Promise<void>;
  keywordSearch(spaceId: string, query: string, limit: number): Promise<ChunkHit[]>;
  vectorSearch(
    spaceId: string,
    embedding: number[],
    limit: number,
    space?: VectorSpace,
  ): Promise<ChunkHit[]>;
  /**
   * Make sure an organisation's vector space exists, BEFORE anything writes
   * to it — ADR-005.
   *
   * Creating a partition is DDL, and DDL needs an exclusive lock on the
   * parent table. Doing it inside the transaction that is already inserting
   * vectors deadlocks: the insert holds a lock the DDL waits for, and the DDL
   * holds up the insert that would release it. Measured as a hung request.
   *
   * So it is its own step, called before the write and outside its
   * transaction.
   */
  prepareVectorSpace?(space: VectorSpace): Promise<void>;

  /**
   * Which organisation owns a workspace — ADR-005.
   *
   * The vector space is per organisation and the service is handed a
   * workspace, so somebody has to resolve one to the other. Doing it here
   * rather than threading `orgId` through every caller keeps it where it
   * belongs: an organisation is a property of the workspace, not of the
   * request.
   *
   * REQUIRED, deliberately. An implementation without it would return no
   * organisation, the semantic channel would quietly stop running, and search
   * would degrade to keyword with nothing to show for it. A compile error is
   * a better way to find that out.
   */
  orgOfSpace(spaceId: string): Promise<string | null>;
  /** Distinct notes semantically close to `noteId`, excluding it. */
  relatedToNote(
    spaceId: string,
    noteId: string,
    limit: number,
  ): Promise<{ noteId: string; text: string; distance: number }[]>;
}

export interface SearchResult {
  noteId: string;
  title: string;
  snippet: string;
  score: number;
  /**
   * The note is archived (migration 0035). Present only when it is: a live
   * note carries no flag, so every existing consumer keeps reading the same
   * shape it always did.
   *
   * Archived notes are answered, not hidden — see ARCHIVED_SCORE_FACTOR.
   */
  archived?: true;
  /**
   * How this result is ageing, in its OWN cadence (ADR-002). Absent when the
   * deployment has no cadence source wired — the field is optional rather than
   * defaulted, because "we did not measure" and "measured as fresh" are
   * different claims and a default would erase the difference.
   */
  freshness?: StalenessAssessment;
}

/**
 * Where the change cadence of an entity comes from — satisfied by the Drizzle
 * provenance repository. A batch lookup on purpose: one query for the handful
 * of results actually returned, never one per hit.
 */
export interface CadenceSource {
  cadenceForNotes(noteIds: string[]): Promise<Map<string, ChangeCadence>>;
}

/**
 * How much an archived note's score is worth against a live one.
 *
 * Applied AFTER the top-K cut, on purpose. Archiving says "not in front of me
 * any more", not "forget it": a penalty applied before the cut would push
 * archived notes out of the answer entirely, and then archiving would be the
 * soft delete this feature exists to avoid. Here it can only change the order
 * of what was already going to be returned.
 */
export const ARCHIVED_SCORE_FACTOR = 0.5;

/** hybrid = keyword + semantic (RRF); keyword = lexical only; semantic = vector only. */
export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchServiceOptions {
  reranker?: Reranker;
  /** Optional: when present, every result carries its freshness assessment. */
  cadence?: CadenceSource;
  /** Candidates fetched per channel before fusion (topK * mult, min 20). */
  candidateMultiplier?: number;
  /**
   * The embedder for a given organisation — ADR-005.
   *
   * Absent, or returning null, means "use the default", which is what every
   * installation does until somebody configures a provider per organisation.
   */
  embedderFor?: (orgId: string) => Promise<EmbeddingProvider | null>;
  /**
   * An embedder for a SPECIFIC vector space, from what the catalogue stored
   * about it (migration 0034).
   *
   * Needed because "the organisation's embedder" and "the embedder that made
   * the vectors we are searching" stop being the same thing the moment a model
   * change is in flight. Returning null means the space cannot be served —
   * a row registered before the credentials moved onto it, typically — and the
   * service falls back to the configured embedder, which is the behaviour
   * every installation had before this existed.
   */
  embedderForSpace?: (space: VectorSpaceModel) => Promise<EmbeddingProvider | null>;
}

/**
 * Orchestrates the semantic memory (PRD §8):
 * - index/remove: chunk + embed + persist (implements NoteIndexer).
 * - search: keyword (FTS) + vector in parallel → RRF → best chunk per note
 *   → rerank → results with snippet.
 */
export class SearchService implements NoteIndexer {
  private readonly reranker: Reranker;
  private readonly candidateMultiplier: number;
  private readonly cadence?: CadenceSource;
  private readonly embedderFor?: (orgId: string) => Promise<EmbeddingProvider | null>;
  private readonly embedderForSpace?: (
    space: VectorSpaceModel,
  ) => Promise<EmbeddingProvider | null>;

  constructor(
    private readonly repo: SearchRepository,
    /**
     * The default embedder. Each organisation may override it (ADR-005) via
     * `options.embedderFor`; this is what an installation that has configured
     * nothing per organisation uses, which is every installation until
     * somebody opens the admin console.
     */
    private readonly embedder: EmbeddingProvider,
    private readonly notes: NotesRepository,
    options: SearchServiceOptions = {},
  ) {
    this.embedderFor = options.embedderFor;
    this.embedderForSpace = options.embedderForSpace;
    this.reranker = options.reranker ?? new LexicalReranker();
    this.cadence = options.cadence;
    this.candidateMultiplier = options.candidateMultiplier ?? 4;
  }

  /**
   * The embedder this organisation searches with — ADR-005.
   *
   * Taken from the embedder itself rather than from a global "active model"
   * flag: a search must read back from the space it wrote into, and resolving
   * the model from a flag is how vectors end up filed under one that did not
   * make them.
   */
  private async embedderOf(orgId: string | null): Promise<EmbeddingProvider> {
    if (!orgId || !this.embedderFor) return this.embedder;
    return (await this.embedderFor(orgId)) ?? this.embedder;
  }

  /**
   * Where an organisation's vectors live, and which model made them.
   *
   * Organisation first in the slot, so two organisations on the same model
   * never share a partition. An HNSW index shared between a tenant with ten
   * vectors and one with twenty thousand returns the small tenant NOTHING —
   * the index's nearest candidates all belong to the large one and the tenant
   * filter removes every one. Measured at 0 of 5 against 5 of 5.
   */
  vectorSpaceOf(orgId: string, embedder: EmbeddingProvider): VectorSpace {
    const d = embedder.describe?.();
    const key = `${d?.provider ?? 'unknown'}:${d?.model ?? 'default'}@${embedder.dimensions}`;
    return { slot: `${orgId}:${key}`, orgId, dimensions: embedder.dimensions };
  }

  /**
   * Which spaces a workspace reads from and writes to — ADR-003's blue/green.
   *
   * Reads come from the ACTIVE model and writes go to every space that exists,
   * and the difference between those two sentences is the whole bug this
   * replaced. Before, both followed the organisation's CONFIGURATION: the
   * moment somebody saved a new model, queries were embedded with it and asked
   * its empty partition — measured at zero results — while the catalogue still
   * called the old model active, so `related`, which does read the catalogue,
   * answered nothing at all. Then the reindex re-embedded every note into the
   * new space and, because replacing a note's chunks cascades to its vectors,
   * emptied the old one. An `active` model with no vectors, and nothing to
   * roll back to.
   *
   * `read` is the space queries are answered from. `writes` is every space
   * that must receive the vectors of a save, `read` first.
   *
   * Falls back to the configured embedder, exactly as before, whenever the
   * catalogue cannot answer: no organisation owns the workspace, the
   * repository has no `modelsOf` (an in-memory double), or the active model's
   * provider cannot be rebuilt because it was registered before its
   * credentials travelled with it.
   */
  private async lanes(spaceId: string): Promise<{
    read: { embedder: EmbeddingProvider; space: VectorSpace } | null;
    writes: { embedder: EmbeddingProvider; space: VectorSpace }[];
  }> {
    const orgId = await this.repo.orgOfSpace(spaceId);
    const configured = await this.embedderOf(orgId);
    const asConfigured = orgId
      ? { embedder: configured, space: this.vectorSpaceOf(orgId, configured) }
      : null;

    if (!orgId || !this.repo.modelsOf || !this.embedderForSpace) {
      return { read: asConfigured, writes: asConfigured ? [asConfigured] : [] };
    }

    const models = await this.repo.modelsOf(orgId);
    if (models.length === 0) {
      return { read: asConfigured, writes: asConfigured ? [asConfigured] : [] };
    }

    const configuredSlot = asConfigured?.space.slot;
    const laneFor = async (m: VectorSpaceModel) => {
      // The configured model is already built and already holds whatever the
      // environment gave it; rebuilding it from the catalogue row would be a
      // second provider for the same space, and a second HTTP client.
      const embedder =
        m.slot === configuredSlot ? configured : await this.embedderForSpace!(m);
      return embedder ? { embedder, space: { slot: m.slot, orgId, dimensions: m.dimensions } } : null;
    };

    const active = models.find((m) => m.state === 'active');
    const read = active ? await laneFor(active) : null;

    const writes: { embedder: EmbeddingProvider; space: VectorSpace }[] = [];
    if (read) writes.push(read);
    for (const m of models) {
      if (m.state === 'active') continue;
      const lane = await laneFor(m);
      if (lane) writes.push(lane);
    }

    // Nothing usable in the catalogue — an active model whose provider cannot
    // be rebuilt, and no building one either. The configured embedder is the
    // only thing left that can answer, and answering from the wrong space is
    // still better than a workspace that cannot search at all.
    if (writes.length === 0) {
      return { read: asConfigured, writes: asConfigured ? [asConfigured] : [] };
    }
    return { read: read ?? writes[0], writes };
  }

  async index(note: Note): Promise<void> {
    const { writes } = await this.lanes(note.spaceId);
    const source = `${note.title}\n\n${note.contentMd}`.trim();
    await this.repo.setTags(note.id, note.spaceId, parseTags(source));
    await this.repo.setLinks(note.id, note.spaceId, uniqueTargets(note.contentMd));
    // Facts are derived here for the same reason tags and wikilinks are: one
    // pass over the markdown at save time, and the note stays the only place
    // a wrong value can be corrected. Derived from `contentMd` alone, not
    // from the title-prefixed `source` — a title is not a table row.
    await this.repo.setFacts?.(note.id, note.spaceId, factsOf(note.contentMd));
    const chunks = chunkMarkdown(source);
    if (chunks.length === 0) {
      await this.repo.removeChunks(note.id);
      return;
    }
    const texts = chunks.map((c) => c.text);
    // One embedding pass per space in flight. Normally there is exactly one;
    // during a model change there are two, and skipping the second is what
    // made the change destructive.
    const perLane = await Promise.all(writes.map((lane) => lane.embedder.embed(texts)));
    for (const lane of writes) await this.repo.prepareVectorSpace?.(lane.space);
    // One detection per note, over title + body: the lexical channel needs a
    // stemmer that speaks the note's language, and a chunk is too short a
    // sample to ask twice. A note nobody can place keeps the default.
    const ftsConfig = ftsConfigFor(source);
    await this.repo.indexChunks(
      note.id,
      note.spaceId,
      chunks.map((c, i) => ({
        text: c.text,
        index: c.index,
        embedding: perLane[0]?.[i] ?? [],
        ftsConfig,
      })),
      writes[0]?.space,
      writes.slice(1).map((lane, i) => ({ space: lane.space, embeddings: perLane[i + 1] })),
    );
  }

  /** Notes semantically close to a given one. Thin pass-through to the repo. */
  async related(
    spaceId: string,
    noteId: string,
    limit: number,
  ): Promise<{ noteId: string; text: string; distance: number }[]> {
    return this.repo.relatedToNote(spaceId, noteId, limit);
  }

  /**
   * Wipe everything derived from a note's content — chunks, tags AND links.
   * Symmetric with soft delete: a trashed note must leave no derived rows
   * behind, so neither search nor the tag/link/graph queries can surface it
   * (and no read path has to remember to filter `deleted_at`). On restore the
   * note is re-`index()`ed, which rebuilds all three from `contentMd`.
   */
  async remove(noteId: string): Promise<void> {
    await this.repo.removeChunks(noteId);
    await this.repo.removeFacts?.(noteId);
    await this.repo.removeTags(noteId);
    await this.repo.removeLinks(noteId);
  }

  async search(
    spaceId: string,
    query: string,
    topK = 5,
    mode: SearchMode = 'hybrid',
  ): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    const candidates = Math.max(topK * this.candidateMultiplier, 20);

    // 'keyword' skips the embedding; 'semantic' skips the keyword channel.
    // Resolved before any database work, and the embedding computed outside
    // any scope — the model call is the slow part (100 ms to 2 s) and holding
    // a pooled connection across it is what ADR-004 went out of its way to
    // avoid.
    // The ACTIVE space, always. A query embedded by one model and compared
    // against vectors made by another is not a worse ranking, it is noise.
    const { read } = await this.lanes(spaceId);
    const space = read?.space;
    if (space) await this.repo.prepareVectorSpace?.(space);
    const qEmbedding =
      mode === 'keyword' || !read ? null : (await read.embedder.embed([query]))[0];
    const [keyword, vector] = await Promise.all([
      mode === 'semantic' ? Promise.resolve([]) : this.repo.keywordSearch(spaceId, query, candidates),
      // No vector space means no organisation owns this workspace — it does
      // not exist, or the repository cannot resolve one. The semantic channel
      // has nothing to read, so it stays empty and keyword carries. Throwing
      // here would turn "you searched a space that is not there" into a 500.
      mode === 'keyword' || !space
        ? Promise.resolve([])
        : this.repo.vectorSearch(spaceId, qEmbedding!, candidates, space),
    ]);

    const fused = reciprocalRankFusion([keyword.map((c) => c.id), vector.map((c) => c.id)]);
    const chunkById = new Map<string, ChunkHit>();
    for (const c of [...keyword, ...vector]) chunkById.set(c.id, c);

    // Best chunk per note, preserving the fused order.
    const seen = new Set<string>();
    const perNote: { noteId: string; text: string }[] = [];
    for (const f of fused) {
      const c = chunkById.get(f.id);
      if (!c || seen.has(c.noteId)) continue;
      seen.add(c.noteId);
      perNote.push({ noteId: c.noteId, text: c.text });
    }

    // Titles go to the reranker too. A chunk is a slice of the body, so
    // without this the one place a note states what it is about is invisible
    // to the stage whose job is judging aboutness.
    const titles = new Map<string, string>();
    await Promise.all(
      perNote.map(async (n) => {
        const note = await this.notes.findById(n.noteId);
        if (note) titles.set(n.noteId, note.title);
      }),
    );

    const reranked = await this.reranker.rerank(
      query,
      perNote.map((n) => ({ id: n.noteId, text: n.text, title: titles.get(n.noteId) })),
      topK,
    );

    const results: SearchResult[] = [];
    const notesById = new Map<string, Note>();
    for (const r of reranked) {
      const note = await this.notes.findById(r.id);
      if (!note) continue;
      notesById.set(note.id, note);
      results.push({
        noteId: note.id,
        title: note.title,
        snippet: snippet(note.contentMd),
        score: note.archivedAt ? r.score * ARCHIVED_SCORE_FACTOR : r.score,
        ...(note.archivedAt ? { archived: true as const } : {}),
      });
    }

    // Re-sort once the penalty is in. Stable, so two results that end up level
    // keep the order the reranker gave them.
    results.sort((a, b) => b.score - a.score);

    // One batch lookup for the results being returned — never one per hit, and
    // never a pass over the corpus. Freshness is a subtraction from here.
    if (this.cadence && results.length > 0) {
      const cadences = await this.cadence.cadenceForNotes(results.map((r) => r.noteId));
      for (const result of results) {
        const c = cadences.get(result.noteId);
        if (!c) continue;
        const note = notesById.get(result.noteId)!;
        result.freshness = assessStaleness(c, structuralKindOf(note.contentMd));
      }
    }
    return results;
  }
}

function snippet(md: string, max = 200): string {
  const clean = md.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}
