import { and, eq, sql } from 'drizzle-orm';
import type { Fact } from '@diluxite/core';
import type { Db } from './client';
import { facts } from './schema';

/**
 * Storage for facts derived from note tables — ADR-001 step 2.
 *
 * There is no update path, only replace: a note's facts are re-derived whole
 * from its markdown, the same contract `note_tags` and `note_links` already
 * have. Anything else would let a stored fact outlive the row it came from.
 */

export interface FactHit {
  noteId: string;
  keyColumn: string;
  key: string;
  columnName: string;
  value: string;
  sourceLine: number;
}

/** How many rows one lookup may return before it stops being an exact answer. */
export const FACT_LOOKUP_LIMIT = 20;

export class DrizzleFactsRepository {
  constructor(private readonly db: Db) {}

  /** Replace a note's entire fact set. Empty `rows` just clears it. */
  async replaceForNote(noteId: string, spaceId: string, rows: Fact[]): Promise<void> {
    await this.db.delete(facts).where(eq(facts.noteId, noteId));
    if (rows.length === 0) return;
    await this.db.insert(facts).values(
      rows.map((f) => ({
        noteId,
        spaceId,
        keyColumn: f.keyColumn,
        key: f.key,
        columnName: f.column,
        value: f.value,
        sourceLine: f.line,
      })),
    );
  }

  async removeForNote(noteId: string): Promise<void> {
    await this.db.delete(facts).where(eq(facts.noteId, noteId));
  }

  /**
   * Exact lookup by key, case-insensitively.
   *
   * Deliberately EXACT rather than fuzzy. Fuzzy matching here would produce
   * near-miss rows presented with the confidence of a fact, which is the one
   * failure this lane must not have — the semantic channel already covers
   * "something like this", and it is honest about being approximate.
   */
  async lookup(spaceId: string, key: string, limit = FACT_LOOKUP_LIMIT): Promise<FactHit[]> {
    const rows = await this.db
      .select({
        noteId: facts.noteId,
        keyColumn: facts.keyColumn,
        key: facts.key,
        columnName: facts.columnName,
        value: facts.value,
        sourceLine: facts.sourceLine,
      })
      .from(facts)
      .where(and(eq(facts.spaceId, spaceId), sql`lower(${facts.key}) = lower(${key})`))
      .limit(limit);
    return rows;
  }

  /**
   * Every key in a space, lower-cased — the vocabulary a query is matched
   * against.
   *
   * A space has far fewer distinct keys than notes, and the set changes only
   * when a table does, so this is cheap to ask for on a query. It is what
   * lets the lane run on EVERY search without a classifier deciding whether a
   * question "looks factual": the keys themselves decide.
   */
  async keysIn(spaceId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ key: sql<string>`lower(${facts.key})` })
      .from(facts)
      .where(eq(facts.spaceId, spaceId));
    return rows.map((r) => r.key);
  }
}
