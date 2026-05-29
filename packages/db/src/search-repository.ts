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
    const rows = await this.db.execute<{ note_id: string; text: string; distance: number }>(sql`
      WITH src AS (
        SELECT embedding FROM ${chunks}
        WHERE note_id = ${noteId} AND space_id = ${spaceId} AND embedding IS NOT NULL
      )
      SELECT DISTINCT ON (c.note_id)
        c.note_id, c.text,
        MIN(c.embedding <=> s.embedding) AS distance
      FROM ${chunks} c, src s
      WHERE c.space_id = ${spaceId}
        AND c.note_id <> ${noteId}
        AND c.embedding IS NOT NULL
      GROUP BY c.note_id, c.text
      ORDER BY c.note_id, distance ASC
      LIMIT ${limit * 4}
    `);
    // `DISTINCT ON (note_id) … ORDER BY note_id, distance` returns one row per
    // note; sort by distance globally afterwards and trim to `limit`.
    return rows
      .map((r) => ({ noteId: r.note_id, text: r.text, distance: Number(r.distance) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }
}
