import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Note, NoteVersion, NoteVersionsRepository } from '@diluxite/core';
import { VERSION_CAP, VERSION_COALESCE_MS } from '@diluxite/core';
import type { Db } from './client';
import { noteVersions } from './schema';

type Row = typeof noteVersions.$inferSelect;

function toVersion(row: Row): NoteVersion {
  return {
    id: row.id,
    noteId: row.noteId,
    spaceId: row.spaceId,
    title: row.title,
    contentMd: row.contentMd,
    createdAt: row.createdAt,
  };
}

/**
 * Note version history (migration 0023).
 *
 * `record` receives the note's state BEFORE an update and applies the two
 * valves the core contract names: the coalescing window (a burst of saves —
 * collab flushes every ~2s — keeps only the snapshot from before the burst)
 * and the per-note cap (pruned oldest-first, history is a bounded safety net,
 * not an archive). Rows are immutable — there is no update path.
 */
export class DrizzleNoteVersionsRepository implements NoteVersionsRepository {
  constructor(private readonly db: Db) {}

  async record(
    prev: Note,
    opts?: { coalesceMs?: number; cap?: number },
  ): Promise<NoteVersion | null> {
    const coalesceMs = opts?.coalesceMs ?? VERSION_COALESCE_MS;
    const cap = opts?.cap ?? VERSION_CAP;

    const [latest] = await this.db
      .select({ createdAt: noteVersions.createdAt })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, prev.id))
      .orderBy(desc(noteVersions.createdAt), desc(noteVersions.id))
      .limit(1);
    if (latest && Date.now() - latest.createdAt.getTime() < coalesceMs) {
      return null; // the burst already has its "before" snapshot
    }

    const [row] = await this.db
      .insert(noteVersions)
      .values({
        noteId: prev.id,
        spaceId: prev.spaceId,
        title: prev.title,
        contentMd: prev.contentMd,
      })
      .returning();

    // Prune past the cap, oldest first. A subquery keeps it one round-trip.
    await this.db.execute(sql`
      DELETE FROM ${noteVersions}
      WHERE ${noteVersions.id} IN (
        SELECT id FROM ${noteVersions}
        WHERE ${noteVersions.noteId} = ${prev.id}
        ORDER BY ${noteVersions.createdAt} DESC
        OFFSET ${cap}
      )`);

    return toVersion(row);
  }

  async listForNote(noteId: string, limit = 50): Promise<NoteVersion[]> {
    const rows = await this.db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId))
      .orderBy(desc(noteVersions.createdAt), desc(noteVersions.id))
      .limit(limit);
    return rows.map(toVersion);
  }

  /**
   * What the note said at a given moment — the content half of "what did we
   * believe in March".
   *
   * A version row holds the content as it was BEFORE the save that created it,
   * so the text that was live at T is the OLDEST snapshot taken after T. When
   * no snapshot is younger than T, nothing has been saved since: the note's
   * current content is what was live then.
   *
   * The honest limit, and callers have to say it out loud: history is a
   * bounded safety net (`VERSION_CAP`), not an archive. Asking about a moment
   * older than the oldest snapshot returns nothing rather than the current
   * text dressed up as the past.
   */
  async contentAsOf(noteId: string, at: Date): Promise<NoteVersion | null> {
    const [row] = await this.db
      .select()
      .from(noteVersions)
      .where(and(eq(noteVersions.noteId, noteId), gt(noteVersions.createdAt, at)))
      .orderBy(noteVersions.createdAt)
      .limit(1);
    return row ? toVersion(row) : null;
  }

  /**
   * How far back the history goes, and whether it was TRUNCATED to get there.
   *
   * The distinction decides whether an `asOf` answer can be trusted. The oldest
   * snapshot alone does not: for a note saved three times, the first snapshot
   * holds the original text, so a question about any earlier moment is still
   * answerable. It stops being answerable only once the per-note cap starts
   * dropping the oldest rows — and then the honest answer is "I cannot see
   * that far back", not the oldest text I happen to still have.
   */
  async historyReach(noteId: string): Promise<{ oldest: Date | null; truncated: boolean }> {
    const rows = await this.db
      .select({ createdAt: noteVersions.createdAt })
      .from(noteVersions)
      .where(eq(noteVersions.noteId, noteId))
      .orderBy(noteVersions.createdAt);
    return { oldest: rows[0]?.createdAt ?? null, truncated: rows.length >= VERSION_CAP };
  }

  async findById(versionId: string): Promise<NoteVersion | null> {
    const [row] = await this.db
      .select()
      .from(noteVersions)
      .where(eq(noteVersions.id, versionId))
      .limit(1);
    return row ? toVersion(row) : null;
  }
}
