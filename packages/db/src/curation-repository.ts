import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CurationDecision, ScoredCandidate } from '@diluxite/core';
import type { Db } from './client';
import { curationQueue, notes, entityUsage, entityProvenance } from './schema';

/** One card in the weekly batch, as the Review screen reads it. */
export interface CurationItem {
  id: string;
  noteId: string;
  title: string;
  question: string;
  citation: string;
  sourceLine: number | null;
  useCount: number;
  score: number;
  createdAt: Date;
}

/**
 * The curation queue (migration 0039).
 *
 * The batch is REPLACED on every build, never appended to. That is the fixed
 * human budget expressed in storage: what did not fit is not carried, it
 * competes again next time. A table that only grows is the wiki this design
 * exists to avoid.
 */
export class DrizzleCurationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Everything the ordering needs about a space's notes, in one read.
   *
   * Joined here rather than assembled by the caller because the three inputs
   * — usage, confirmation, the note itself — live in three tables and the
   * alternative is a query per candidate.
   *
   * Only notes that have been USED are considered: a note nobody has ever
   * retrieved scores zero anyway, and starting from the usage table keeps this
   * proportional to what the memory leans on rather than to the corpus.
   */
  async candidatesFor(spaceId: string, limit = 500) {
    const rows = await this.db
      .select({
        noteId: notes.id,
        title: notes.title,
        useCount: entityUsage.useCount,
        confirmedAt: entityProvenance.confirmedAt,
        rank: entityProvenance.rank,
        validTo: entityProvenance.validTo,
      })
      .from(entityUsage)
      .innerJoin(notes, eq(notes.id, entityUsage.entityId))
      .leftJoin(
        entityProvenance,
        and(
          eq(entityProvenance.entityId, entityUsage.entityId),
          eq(entityProvenance.entityKind, 'note'),
        ),
      )
      .where(
        and(
          eq(entityUsage.entityKind, 'note'),
          eq(entityUsage.spaceId, spaceId),
          // A trashed note is on its way out; an archived one was deliberately
          // put away. Neither is worth a person's fifteen minutes.
          isNull(notes.deletedAt),
          isNull(notes.archivedAt),
        ),
      )
      .orderBy(desc(entityUsage.useCount))
      .limit(limit);

    const now = Date.now();
    return rows
      // Already superseded or expired: the answer to "does this still hold" is
      // recorded, and asking again is the batch spending itself on noise.
      .filter((r) => r.rank !== 'deprecated' && !(r.validTo && r.validTo.getTime() <= now))
      .map((r) => ({
        noteId: r.noteId,
        title: r.title,
        useCount: r.useCount,
        secondsSinceConfirmed: r.confirmedAt
          ? Math.floor((now - r.confirmedAt.getTime()) / 1000)
          : null,
      }));
  }

  /**
   * Replace the open batch with these.
   *
   * Open items that are not in the new batch are dropped, not left behind:
   * they were this week's best guess and next week has its own. Decided items
   * are never touched — they are the record of what was asked and answered.
   */
  async buildBatch(
    spaceId: string,
    items: (ScoredCandidate & { question: string; citation: string; sourceLine?: number })[],
  ): Promise<number> {
    await this.db
      .delete(curationQueue)
      .where(and(eq(curationQueue.spaceId, spaceId), eq(curationQueue.status, 'open')));
    if (items.length === 0) return 0;
    const rows = await this.db
      .insert(curationQueue)
      .values(
        items.map((i) => ({
          spaceId,
          noteId: i.noteId,
          question: i.question,
          citation: i.citation,
          sourceLine: i.sourceLine ?? null,
          useCount: i.useCount,
          score: i.score,
        })),
      )
      .returning({ id: curationQueue.id });
    return rows.length;
  }

  /** This space's open batch, best first. */
  async openBatch(spaceId: string): Promise<CurationItem[]> {
    const rows = await this.db
      .select({
        id: curationQueue.id,
        noteId: curationQueue.noteId,
        title: notes.title,
        question: curationQueue.question,
        citation: curationQueue.citation,
        sourceLine: curationQueue.sourceLine,
        useCount: curationQueue.useCount,
        score: curationQueue.score,
        createdAt: curationQueue.createdAt,
      })
      .from(curationQueue)
      .innerJoin(notes, eq(notes.id, curationQueue.noteId))
      .where(and(eq(curationQueue.spaceId, spaceId), eq(curationQueue.status, 'open')))
      .orderBy(desc(curationQueue.score));
    return rows;
  }

  /**
   * Spaces whose batch is due — the scheduler's only read.
   *
   * A space qualifies when the memory has leaned on it (there is usage to rank
   * by) and its last batch was built before the cutoff, or it never had one.
   * Deliberately NOT "spaces with no open items": rebuilding the moment an
   * owner clears the last card would hand them a fresh batch every time they
   * finished, which is the opposite of a fixed weekly budget.
   */
  async spacesDueForBuild(before: Date, limit = 100): Promise<string[]> {
    const rows = await this.db.execute<{ space_id: string }>(sql`
      SELECT u.space_id
        FROM (SELECT DISTINCT space_id FROM entity_usage WHERE entity_kind = 'note') u
        LEFT JOIN (
          SELECT space_id, MAX(created_at) AS last_built
            FROM curation_queue GROUP BY space_id
        ) q ON q.space_id = u.space_id
       WHERE q.last_built IS NULL OR q.last_built < ${before.toISOString()}::timestamptz
       LIMIT ${limit}`);
    return rows.map((r) => r.space_id);
  }

  /** Which space an item belongs to, so a route can authorise before writing. */
  async spaceOf(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ spaceId: curationQueue.spaceId })
      .from(curationQueue)
      .where(eq(curationQueue.id, id))
      .limit(1);
    return row?.spaceId ?? null;
  }

  /**
   * Record a decision. Returns the item, or null when it was already decided.
   *
   * A rejection carries its reason — the table refuses one without it. An
   * owner must not be able to turn the memory into their version of events in
   * silence, and "it is visible and appealable" is only true if the reason
   * exists.
   */
  async decide(
    id: string,
    decision: CurationDecision,
    by: string | null,
    reason?: string,
  ): Promise<{ id: string; noteId: string } | null> {
    const [row] = await this.db
      .update(curationQueue)
      .set({ status: decision, decidedBy: by, decidedAt: new Date(), reason: reason ?? null })
      .where(and(eq(curationQueue.id, id), eq(curationQueue.status, 'open')))
      .returning({ id: curationQueue.id, noteId: curationQueue.noteId });
    return row ?? null;
  }

  /**
   * The median seconds a decision actually takes, from decisions already made.
   *
   * This is the budget's divisor, and it is measured rather than declared:
   * the gap between an item being decided and the one decided before it,
   * within the same batch. Null until there is enough to have a median, which
   * is why a fresh installation proposes a cold-start batch instead.
   *
   * Gaps longer than five minutes are dropped: they are the owner closing the
   * laptop, not a decision that took an hour.
   */
  async medianSecondsPerDecision(spaceId: string): Promise<number | null> {
    const [row] = await this.db.execute<{ median: number | null }>(sql`
      WITH decided AS (
        SELECT decided_at,
               LAG(decided_at) OVER (ORDER BY decided_at) AS prev
          FROM curation_queue
         WHERE space_id = ${spaceId} AND decided_at IS NOT NULL
      ), gaps AS (
        SELECT EXTRACT(EPOCH FROM (decided_at - prev)) AS seconds
          FROM decided
         WHERE prev IS NOT NULL
      )
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds)::float AS median
        FROM gaps
       WHERE seconds > 0 AND seconds <= 300
    `);
    return row?.median ?? null;
  }

  /** Items already decided, for the audit trail behind the batch. */
  async decidedFor(spaceId: string, noteIds: string[]) {
    if (noteIds.length === 0) return [];
    return this.db
      .select()
      .from(curationQueue)
      .where(
        and(
          eq(curationQueue.spaceId, spaceId),
          inArray(curationQueue.noteId, noteIds),
          sql`${curationQueue.status} <> 'open'`,
        ),
      );
  }
}
