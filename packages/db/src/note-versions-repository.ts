import { desc, eq, sql } from 'drizzle-orm';
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
      .orderBy(desc(noteVersions.createdAt))
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
      .orderBy(desc(noteVersions.createdAt))
      .limit(limit);
    return rows.map(toVersion);
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
