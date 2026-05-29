import { chunkMarkdown } from './chunking';
import { parseTags } from './tags';
import { uniqueTargets } from './wikilinks';
import { reciprocalRankFusion } from './rrf';
import { IdentityReranker } from './providers';
import type { EmbeddingProvider, Reranker } from './providers';
import type { Note, NoteIndexer, NotesRepository } from './notes';

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
}

/** hybrid = keyword + semantic (RRF); keyword = lexical only; semantic = vector only. */
export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchServiceOptions {
  reranker?: Reranker;
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

  constructor(
    private readonly repo: SearchRepository,
    private readonly embedder: EmbeddingProvider,
    private readonly notes: NotesRepository,
    options: SearchServiceOptions = {},
  ) {
    this.reranker = options.reranker ?? new IdentityReranker();
    this.candidateMultiplier = options.candidateMultiplier ?? 4;
  }

  async index(note: Note): Promise<void> {
    const source = `${note.title}\n\n${note.contentMd}`.trim();
    await this.repo.setTags(note.id, note.spaceId, parseTags(source));
    await this.repo.setLinks(note.id, note.spaceId, uniqueTargets(note.contentMd));
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

  async remove(noteId: string): Promise<void> {
    await this.repo.removeChunks(noteId);
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

    const reranked = await this.reranker.rerank(
      query,
      perNote.map((n) => ({ id: n.noteId, text: n.text })),
      topK,
    );

    const results: SearchResult[] = [];
    for (const r of reranked) {
      const note = await this.notes.findById(r.id);
      if (!note) continue;
      results.push({
        noteId: note.id,
        title: note.title,
        snippet: snippet(note.contentMd),
        score: r.score,
      });
    }
    return results;
  }
}

function snippet(md: string, max = 200): string {
  const clean = md.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}
