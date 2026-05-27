import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { noteTags } from './schema';

export interface TagCount {
  tag: string;
  count: number;
}

export class DrizzleTagsRepository {
  constructor(private readonly db: Db) {}

  /** Tags in the space with their note count, ordered by descending usage. */
  async listForSpace(spaceId: string): Promise<TagCount[]> {
    return this.db
      .select({ tag: noteTags.tag, count: sql<number>`count(*)::int` })
      .from(noteTags)
      .where(eq(noteTags.spaceId, spaceId))
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
