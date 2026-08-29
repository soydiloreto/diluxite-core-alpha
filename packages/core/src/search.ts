import { chunkMarkdown } from './chunking';
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

export interface ChunkToIndex {
  text: string;
  index: number;
  embedding: number[];
}

/** Search port (Postgres FTS + pgvector in @diluxite/db). */
export interface SearchRepository {
  indexChunks(noteId: string, spaceId: string, chunks: ChunkToIndex[]): Promise<void>;
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
  vectorSearch(spaceId: string, embedding: number[], limit: number): Promise<ChunkHit[]>;
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

/** hybrid = keyword + semantic (RRF); keyword = lexical only; semantic = vector only. */
export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchServiceOptions {
  reranker?: Reranker;
  /** Optional: when present, every result carries its freshness assessment. */
  cadence?: CadenceSource;
  /** Candidates fetched per channel before fusion (topK * mult, min 20). */
  candidateMultiplier?: number;
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

  constructor(
    private readonly repo: SearchRepository,
    private readonly embedder: EmbeddingProvider,
    private readonly notes: NotesRepository,
    options: SearchServiceOptions = {},
  ) {
    this.reranker = options.reranker ?? new LexicalReranker();
    this.cadence = options.cadence;
    this.candidateMultiplier = options.candidateMultiplier ?? 4;
  }

  async index(note: Note): Promise<void> {
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
    const embeddings = await this.embedder.embed(chunks.map((c) => c.text));
    await this.repo.indexChunks(
      note.id,
      note.spaceId,
      chunks.map((c, i) => ({ text: c.text, index: c.index, embedding: embeddings[i] })),
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
    const qEmbedding = mode === 'keyword' ? null : (await this.embedder.embed([query]))[0];
    const [keyword, vector] = await Promise.all([
      mode === 'semantic' ? Promise.resolve([]) : this.repo.keywordSearch(spaceId, query, candidates),
      mode === 'keyword'
        ? Promise.resolve([])
        : this.repo.vectorSearch(spaceId, qEmbedding!, candidates),
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
        score: r.score,
      });
    }

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
