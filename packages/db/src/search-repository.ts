import { and, cosineDistance, desc, eq, sql } from 'drizzle-orm';
import type { ChunkHit, ChunkToIndex, SearchRepository } from '@diluxite/core';
import type { Db } from './client';
import { chunks, noteLinks, noteTags } from './schema';

export class DrizzleSearchRepository implements SearchRepository {
  constructor(private readonly db: Db) {}

  async indexChunks(noteId: string, spaceId: string, items: ChunkToIndex[]): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.noteId, noteId));
    if (items.length === 0) return;
    await this.db.insert(chunks).values(
      items.map((c) => ({
        noteId,
        spaceId,
        text: c.text,
        position: c.index,
        embedding: c.embedding,
      })),
    );
  }

  async removeChunks(noteId: string): Promise<void> {
    await this.db.delete(chunks).where(eq(chunks.noteId, noteId));
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
    return this.db
      .select({ id: chunks.id, noteId: chunks.noteId, text: chunks.text })
      .from(chunks)
      .where(and(eq(chunks.spaceId, spaceId), sql`${tsv} @@ ${tsq}`))
      .orderBy(desc(sql`ts_rank(${tsv}, ${tsq})`))
      .limit(limit);
  }

  // Vector search (cosine distance; smaller = closer).
  async vectorSearch(spaceId: string, embedding: number[], limit: number): Promise<ChunkHit[]> {
    return this.db
      .select({ id: chunks.id, noteId: chunks.noteId, text: chunks.text })
      .from(chunks)
      .where(eq(chunks.spaceId, spaceId))
      .orderBy(cosineDistance(chunks.embedding, embedding))
      .limit(limit);
  }
}
