import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { notaTags } from './schema';

export interface TagCount {
  tag: string;
  count: number;
}

export class DrizzleTagsRepository {
  constructor(private readonly db: Db) {}

  /** Tags del espacio con su cantidad de notas, de mayor a menor uso. */
  async listForSpace(espacioId: string): Promise<TagCount[]> {
    return this.db
      .select({ tag: notaTags.tag, count: sql<number>`count(*)::int` })
      .from(notaTags)
      .where(eq(notaTags.espacioId, espacioId))
      .groupBy(notaTags.tag)
      .orderBy(desc(sql`count(*)`), notaTags.tag);
  }

  /** IDs de notas que tienen un tag dado (case-insensitive). */
  async noteIdsByTag(espacioId: string, tag: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: notaTags.notaId })
      .from(notaTags)
      .where(and(eq(notaTags.espacioId, espacioId), eq(notaTags.tag, tag.toLowerCase())));
    return rows.map((r) => r.id);
  }
}
