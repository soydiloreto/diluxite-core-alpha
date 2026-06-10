import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { notes, noteTags } from './schema';

export interface TagCount {
  tag: string;
  count: number;
}

export class DrizzleTagsRepository {
  constructor(private readonly db: Db) {}

  /** Tags in the space with their note count, ordered by descending usage. */
  async listForSpace(spaceId: string): Promise<TagCount[]> {
    // Join notes + filter trashed (deleted_at IS NOT NULL) so tags that only
    // live on soft-deleted notes don't inflate the counts / cloud.
    return this.db
      .select({ tag: noteTags.tag, count: sql<number>`count(*)::int` })
      .from(noteTags)
      .innerJoin(notes, eq(notes.id, noteTags.noteId))
      .where(and(eq(noteTags.spaceId, spaceId), isNull(notes.deletedAt)))
      .groupBy(noteTags.tag)
      .orderBy(desc(sql`count(*)`), noteTags.tag);
  }

  /** IDs of notes that carry a given tag (case-insensitive). */
  async noteIdsByTag(spaceId: string, tag: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: noteTags.noteId })
      .from(noteTags)
      .where(and(eq(noteTags.spaceId, spaceId), eq(noteTags.tag, tag.toLowerCase())));
    return rows.map((r) => r.id);
  }
}
