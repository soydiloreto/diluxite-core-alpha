import { and, cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { ChunkHit, ChunkToIndex, SearchRepository } from '@diluxite/core';
import type { Db } from './client';
import { chunks, notaLinks, notaTags } from './schema';

export class DrizzleSearchRepository implements SearchRepository {
  constructor(private readonly db: Db) {}

  async indexChunks(notaId: string, espacioId: string, items: ChunkToIndex[]): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.notaId, notaId));
    if (items.length === 0) return;
    await this.db.insert(chunks).values(
      items.map((c) => ({
        notaId,
        espacioId,
        texto: c.text,
        orden: c.index,
        embedding: c.embedding,
      })),
    );
  }

  async removeChunks(notaId: string): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.notaId, notaId));
  }

  async setTags(notaId: string, espacioId: string, tags: string[]): Promise<void> {
    await this.db.delete(notaTags).where(eq(notaTags.notaId, notaId));
    const unique = [...new Set(tags.map((t) => t.toLowerCase()))];
    if (unique.length === 0) return;
    await this.db
      .insert(notaTags)
      .values(unique.map((tag) => ({ notaId, espacioId, tag })))
      .onConflictDoNothing();
  }

  async setLinks(notaId: string, espacioId: string, targets: string[]): Promise<void> {
    await this.db.delete(notaLinks).where(eq(notaLinks.notaId, notaId));
    const unique = [...new Set(targets.map((t) => t.toLowerCase()))];
    if (unique.length === 0) return;
    await this.db
      .insert(notaLinks)
      .values(unique.map((target) => ({ notaId, espacioId, target })))
      .onConflictDoNothing();
  }

  // Búsqueda por palabra (FTS español, ranking por ts_rank).
  async keywordSearch(espacioId: string, query: string, limit: number): Promise<ChunkHit[]> {
    const tsv = sql`to_tsvector('spanish', ${chunks.texto})`;
    const tsq = sql`websearch_to_tsquery('spanish', ${query})`;
    return this.db
      .select({ id: chunks.id, notaId: chunks.notaId, texto: chunks.texto })
      .from(chunks)
      .where(and(eq(chunks.espacioId, espacioId), sql`${tsv} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${tsv}, ${tsq})`))
      .limit(limit);
  }

  // Búsqueda vectorial (distancia coseno; menor = más cerca).
  async vectorSearch(espacioId: string, embedding: number[], limit: number): Promise<ChunkHit[]> {
    return this.db
      .select({ id: chunks.id, notaId: chunks.notaId, texto: chunks.texto })
      .from(chunks)
      .where(eq(chunks.espacioId, espacioId))
      .orderBy(cosineDistance(chunks.embedding, embedding))
      .limit(limit);
  }
}
