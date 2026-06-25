import { and, cosineDistance, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ChunkHit, ChunkToIndex, SearchRepository } from '@diluxite/core';
import type { Db } from './client';
import { chunks, noteLinks, notes, noteTags } from './schema';

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
  async vectorSearch(spaceId: string, embedding: number[], limit: number): Promise<ChunkHit[]> {
    // Join notes + filter trashed (see keywordSearch for the rationale).
    return this.db
      .select({ id: chunks.id, noteId: chunks.noteId, text: chunks.text })
      .from(chunks)
      .innerJoin(notes, eq(notes.id, chunks.noteId))
      .where(and(eq(chunks.spaceId, spaceId), isNull(notes.deletedAt)))
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
    // Inner query: nearest chunk per neighbour note via DISTINCT ON, keeping
    // the chunk that minimises the cosine distance (`ORDER BY note_id, distance`).
    // We MUST then re-sort by distance and trim in a wrapping query — applying
    // LIMIT directly to the DISTINCT-ON output cut rows in note_id order
    // (≈random), so the closest neighbours could be dropped before `limit`.
    // Trashed notes are excluded by joining `notes` (deleted_at IS NULL).
    const rows = await this.db.execute<{ note_id: string; text: string; distance: number }>(sql`
      WITH src AS (
        SELECT embedding FROM ${chunks}
        WHERE note_id = ${noteId} AND space_id = ${spaceId} AND embedding IS NOT NULL
      )
      SELECT t.note_id, t.text, t.distance
      FROM (
        SELECT DISTINCT ON (c.note_id)
          c.note_id AS note_id, c.text AS text,
          (c.embedding <=> s.embedding) AS distance
        FROM ${chunks} c
        JOIN ${notes} n ON n.id = c.note_id
        CROSS JOIN src s
        WHERE c.space_id = ${spaceId}
          AND c.note_id <> ${noteId}
          AND c.embedding IS NOT NULL
          AND n.deleted_at IS NULL
        ORDER BY c.note_id, distance ASC
      ) t
      ORDER BY t.distance ASC
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ noteId: r.note_id, text: r.text, distance: Number(r.distance) }));
  }
}
