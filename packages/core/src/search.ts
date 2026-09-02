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
  /**
   * The passage that matched, trimmed — not the note's opening.
   *
   * A search that finds its answer in the last paragraph and quotes the first
   * one makes the reader open the note to find out why it came back.
   */
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
   * Expired or superseded — answered, and marked, so whoever composes with it
   * can say so instead of quoting it as current.
   */
  expired?: true;
  /** Signed by a person who says it still holds (`rank: preferred`). */
  confirmed?: true;
  /** Written down after something went wrong — it ranks above ordinary prose. */
  correction?: true;
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

/**
 * How a result's standing — its rank, its expiry, its measured age — weighs on
 * the order. ADR-002's third axis, finally connected to something.
 *
 * Multipliers rather than a re-sort by category, so a strong match that is
 * slightly overdue still beats a weak match that is fresh. The verdict a user
 * gets is "ranked lower", never "hidden", unless `hideExpired` says otherwise.
 *
 * Every one of these is arithmetic over dates and counts. No model is
 * consulted here, and ADR-002 forbids putting one in this path.
 */
export interface RankingWeights {
  /** Signed by a person and still standing (Wikidata `preferred`). Above 1. */
  preferred: number;
  /** Past its own measured cadence (`level: 'stale'`). Mildly below 1. */
  stale: number;
  /** Expired (`valid_to` in the past) or superseded (`deprecated`). Well below 1. */
  expired: number;
  /**
   * Written down because something was wrong and somebody learned better —
   * PROV-O's activity, not a document type (ADR-002 refuses classes). Above 1:
   * it cost a mistake, so a question it answers should meet it first.
   */
  correction: number;
  /** Drop expired results entirely instead of answering them, marked. */
  hideExpired: boolean;
}

/**
 * What an untouched installation gets.
 *
 * Deliberately NOT neutral: before this, an out-of-date result was flagged and
 * left exactly where it was, which is a warning nobody acts on. Mild for age
 * (being overdue is a suspicion), firm for expired (somebody said it stops
 * being true, or that it already stopped). Showing rather than hiding is the
 * same call archive made, for the same reason.
 */
export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  preferred: 1.2,
  stale: 0.9,
  expired: 0.4,
  correction: 1.5,
  hideExpired: false,
};

/** The PROV activity that marks a note as recorded knowledge from a mistake. */
export const CORRECTION_ACTIVITY = 'correction';

/** How a note stands right now, for the ranking — ADR-002's rank + window. */
export interface ValidityStanding {
  rank: 'preferred' | 'normal' | 'deprecated';
  /** Null = open window. In the past = expired. In the future = still current. */
  validTo: Date | null;
  /** PROV-O's activity — which door produced this note. */
  generatedBy?: string;
}

/**
 * Where standings come from — satisfied by the Drizzle provenance repository.
 *
 * A batch lookup for the handful of results being returned, never one query
 * per hit and never a pass over the corpus, which is the same constraint the
 * cadence source lives under.
 */
export interface ValiditySource {
  standingForNotes(noteIds: string[]): Promise<Map<string, ValidityStanding>>;
}

/**
 * Where "this was used to answer" is recorded.
 *
 * The curation queue ranks candidates by how much the memory leans on them,
 * and nothing counted that. Called with the results actually returned, so one
 * search is one write and the cost is bounded by topK.
 *
 * A failure here must never fail the search: counting is bookkeeping, and a
 * bookkeeping error that swallows somebody's answer is a bad trade.
 */
export interface UsageSink {
  recordUse(noteIds: string[], spaceId: string): Promise<void>;
}

/** hybrid = keyword + semantic (RRF); keyword = lexical only; semantic = vector only. */
export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchServiceOptions {
  reranker?: Reranker;
  /** Optional: when present, every result carries its freshness assessment. */
  cadence?: CadenceSource;
  /**
   * Optional: when present, rank and validity weigh on the order. Absent, the
   * deployment ranks exactly as it did before this existed.
   */
  validity?: ValiditySource;
  /** Optional: when present, every answered result counts as one use. */
  usage?: UsageSink;
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
  private readonly validity?: ValiditySource;
  private readonly usage?: UsageSink;
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
    this.validity = options.validity;
    this.usage = options.usage;
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
    weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
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

    // The passage that actually matched, per note. The results used to quote
    // the note's OPENING instead — so a search that found its answer in the
    // last paragraph showed the first one, and the reader had to open the note
    // to see why it was returned at all.
    const matchedText = new Map(perNote.map((n) => [n.noteId, n.text]));

    const results: SearchResult[] = [];
    const notesById = new Map<string, Note>();
    for (const r of reranked) {
      const note = await this.notes.findById(r.id);
      if (!note) continue;
      notesById.set(note.id, note);
      results.push({
        noteId: note.id,
        title: note.title,
        snippet: snippet(matchedText.get(note.id) ?? note.contentMd),
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

    // Standing weighs LAST, over the results already chosen — the same
    // placement archive's demotion uses, and for the same reason: an
    // out-of-date note is answered lower, not removed from the answer. The
    // only thing that removes one is `hideExpired`, which somebody turned on.
    if (this.validity && results.length > 0) {
      const standings = await this.validity.standingForNotes(results.map((r) => r.noteId));
      const now = Date.now();
      const kept: SearchResult[] = [];
      for (const result of results) {
        const standing = standings.get(result.noteId);
        const expired =
          !!standing &&
          (standing.rank === 'deprecated' ||
            (!!standing.validTo && standing.validTo.getTime() <= now));
        if (expired && weights.hideExpired) continue;
        if (expired) {
          result.score *= weights.expired;
          result.expired = true;
        } else if (standing?.rank === 'preferred') {
          result.score *= weights.preferred;
          result.confirmed = true;
        }
        // A correction is not exclusive with being signed: something learned
        // from a mistake AND confirmed by a person is the most authoritative
        // thing the memory holds, and the score should say both.
        if (standing?.generatedBy === CORRECTION_ACTIVITY && !expired) {
          result.score *= weights.correction;
          result.correction = true;
        }
        // Age and standing multiply rather than compete: a note can be both
        // overdue and unsigned, and the answer should say so once in the
        // score.
        if (result.freshness?.level === 'stale') result.score *= weights.stale;
        kept.push(result);
      }
      kept.sort((a, b) => b.score - a.score);
      await this.countUse(kept, spaceId);
      return kept;
    }
    await this.countUse(results, spaceId);
    return results;
  }

  /**
   * One statement, for the page of results being returned.
   *
   * Swallows its own errors on purpose: this is bookkeeping on a read path,
   * and a counter that cannot be written is not a reason to fail somebody's
   * search. It is also why it is not fire-and-forget — an unhandled rejection
   * from a floating promise takes the process down in Node, which is a much
   * worse outcome than a lost count.
   */
  private async countUse(results: SearchResult[], spaceId: string): Promise<void> {
    if (!this.usage || results.length === 0) return;
    try {
      await this.usage.recordUse(
        results.map((r) => r.noteId),
        spaceId,
      );
    } catch {
      // Intentionally ignored — see above.
    }
  }
}

function snippet(md: string, max = 200): string {
  const clean = md.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}
