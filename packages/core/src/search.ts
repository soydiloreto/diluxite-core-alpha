import { chunkMarkdown } from './chunking';
import { reciprocalRankFusion } from './rrf';
import { IdentityReranker } from './providers';
import type { EmbeddingProvider, Reranker } from './providers';
import type { Note, NoteIndexer, NotesRepository } from './notes';

export interface ChunkHit {
  id: string;
  notaId: string;
  texto: string;
}

export interface ChunkToIndex {
  text: string;
  index: number;
  embedding: number[];
}

/** Puerto de búsqueda (Postgres FTS + pgvector en @diluxite/db). */
export interface SearchRepository {
  indexChunks(notaId: string, espacioId: string, chunks: ChunkToIndex[]): Promise<void>;
  removeChunks(notaId: string): Promise<void>;
  keywordSearch(espacioId: string, query: string, limit: number): Promise<ChunkHit[]>;
  vectorSearch(espacioId: string, embedding: number[], limit: number): Promise<ChunkHit[]>;
}

export interface SearchResult {
  noteId: string;
  titulo: string;
  snippet: string;
  score: number;
}

export interface SearchServiceOptions {
  reranker?: Reranker;
  /** Candidatos a recuperar por canal antes de fusionar (topK * mult, mín 20). */
  candidateMultiplier?: number;
}

/**
 * Orquesta la memoria semántica (PRD §8):
 * - index/remove: chunk + embed + persistir (implementa NoteIndexer).
 * - search: keyword (FTS) + vectorial en paralelo → RRF → mejor chunk por nota
 *   → rerank → resultados con snippet.
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
    const source = `${note.titulo}\n\n${note.contenidoMd}`.trim();
    const chunks = chunkMarkdown(source);
    if (chunks.length === 0) {
      await this.repo.removeChunks(note.id);
      return;
    }
    const embeddings = await this.embedder.embed(chunks.map((c) => c.text));
    await this.repo.indexChunks(
      note.id,
      note.espacioId,
      chunks.map((c, i) => ({ text: c.text, index: c.index, embedding: embeddings[i] })),
    );
  }

  async remove(noteId: string): Promise<void> {
    await this.repo.removeChunks(noteId);
  }

  async search(espacioId: string, query: string, topK = 5): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    const candidates = Math.max(topK * this.candidateMultiplier, 20);
    const [qEmbedding] = await this.embedder.embed([query]);

    const [keyword, vector] = await Promise.all([
      this.repo.keywordSearch(espacioId, query, candidates),
      this.repo.vectorSearch(espacioId, qEmbedding, candidates),
    ]);

    const fused = reciprocalRankFusion([keyword.map((c) => c.id), vector.map((c) => c.id)]);
    const chunkById = new Map<string, ChunkHit>();
    for (const c of [...keyword, ...vector]) chunkById.set(c.id, c);

    // Mejor chunk por nota, conservando el orden fusionado.
    const seen = new Set<string>();
    const perNote: { notaId: string; texto: string }[] = [];
    for (const f of fused) {
      const c = chunkById.get(f.id);
      if (!c || seen.has(c.notaId)) continue;
      seen.add(c.notaId);
      perNote.push({ notaId: c.notaId, texto: c.texto });
    }

    const reranked = await this.reranker.rerank(
      query,
      perNote.map((n) => ({ id: n.notaId, text: n.texto })),
      topK,
    );

    const results: SearchResult[] = [];
    for (const r of reranked) {
      const note = await this.notes.findById(r.id);
      if (!note) continue;
      results.push({
        noteId: note.id,
        titulo: note.titulo,
        snippet: snippet(note.contenidoMd),
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
