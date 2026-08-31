import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type {
  Note,
  NotesRepository,
  CreateNoteInput,
  UpdateNotePatch,
  WriteAttribution,
} from '@diluxite/core';
import type { Db } from './client';
import { notes } from './schema';
import { DrizzleNoteVersionsRepository } from './note-versions-repository';
import { DrizzleEntityProvenanceRepository } from './entity-provenance-repository';

type Row = typeof notes.$inferSelect;

function toNote(row: Row): Note {
  return {
    id: row.id,
    spaceId: row.spaceId,
    folderId: row.folderId,
    title: row.title,
    contentMd: row.contentMd,
    favorite: row.favorite,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Notes repository.
 *
 * Trash bin contract (alpha.43):
 *   - All "normal" reads (findById, findByTitle, list) **exclude** soft-deleted
 *     rows (`deleted_at IS NOT NULL`). The trash UI uses `listDeleted`.
 *   - `delete` / `deleteMany` are now SOFT — they set `deleted_at = now()`.
 *   - `restore` clears `deleted_at`.
 *   - `purge` / `purgeMany` / `purgeTrashForSpace` are the only paths that
 *     actually remove rows.
 *
 * This intentionally changes the observable behaviour of the existing
 * REST `DELETE /api/notes/:id` endpoint (still returns 204 + the row is
 * filtered out of subsequent reads, but it survives in `trash` until
 * purged). Callers that want the old destructive behaviour use `/purge`.
 */
export class DrizzleNotesRepository implements NotesRepository {
  /** Same-db history writer — every content update snapshots through it. */
  private readonly versions: DrizzleNoteVersionsRepository;
  /**
   * Provenance and change statistics (ADR-002). Wired HERE for the same
   * reason the version history is: with collab on, typing never reaches
   * NotesService — Hocuspocus persists through this repository directly. A
   * hook one layer up records nothing for the most common write path, which
   * is a lesson this codebase already paid for once.
   */
  private readonly provenance: DrizzleEntityProvenanceRepository;

  constructor(private readonly db: Db) {
    this.versions = new DrizzleNoteVersionsRepository(db);
    this.provenance = new DrizzleEntityProvenanceRepository(db);
  }

  async create(input: CreateNoteInput, by?: WriteAttribution): Promise<Note> {
    const [row] = await this.db
      .insert(notes)
      .values({
        spaceId: input.spaceId,
        title: input.title,
        contentMd: input.contentMd ?? '',
        folderId: input.folderId ?? null,
      })
      .returning();
    const note = toNote(row);
    await this.provenance.record('note', note.id, note.spaceId, by ?? {});
    await this.provenance.recordChange('note', note.id, note.spaceId);
    return note;
  }

  /**
   * Atomic get-or-create by (spaceId, title). Backs `openOrCreate` in core so
   * two concurrent wikilink follows of `[[Same Title]]` converge on one row
   * instead of racing find-then-create into a duplicate.
   *
   * Relies on the partial UNIQUE index `notes_space_title_live_uniq`
   * (`(space_id, title) WHERE deleted_at IS NULL`, migration 0020). On
   * conflict we DO NOTHING (no RETURNING row) and re-select the live note.
   * `created` reflects whether the INSERT actually produced a row.
   */
  async createIfAbsent(input: CreateNoteInput): Promise<{ note: Note; created: boolean }> {
    const inserted = await this.db
      .insert(notes)
      .values({
        spaceId: input.spaceId,
        title: input.title,
        contentMd: input.contentMd ?? '',
        folderId: input.folderId ?? null,
      })
      .onConflictDoNothing({
        target: [notes.spaceId, notes.title],
        where: isNull(notes.deletedAt),
      })
      .returning();
    if (inserted.length > 0) return { note: toNote(inserted[0]), created: true };
    // Someone else holds the live (space_id, title); fetch theirs.
    const existing = await this.findByTitle(input.spaceId, input.title);
    if (existing) return { note: existing, created: false };
    // Extremely rare: the conflicting row was trashed between INSERT and
    // SELECT. Retry once — the partial index now permits the insert.
    const retry = await this.db
      .insert(notes)
      .values({
        spaceId: input.spaceId,
        title: input.title,
        contentMd: input.contentMd ?? '',
        folderId: input.folderId ?? null,
      })
      .onConflictDoNothing({
        target: [notes.spaceId, notes.title],
        where: isNull(notes.deletedAt),
      })
      .returning();
    if (retry.length > 0) return { note: toNote(retry[0]), created: true };
    const after = await this.findByTitle(input.spaceId, input.title);
    return { note: after!, created: false };
  }

  async findById(id: string): Promise<Note | null> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)));
    return row ? toNote(row) : null;
  }

  /** Includes trashed rows — used by the trash UI endpoints (restore, purge)
   *  which need to look up a soft-deleted note that `findById` hides. */
  async findByIdIncludingDeleted(id: string): Promise<Note | null> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id));
    return row ? toNote(row) : null;
  }

  async findByTitle(spaceId: string, title: string): Promise<Note | null> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.spaceId, spaceId),
          eq(notes.title, title),
          isNull(notes.deletedAt),
        ),
      );
    return row ? toNote(row) : null;
  }

  async list(spaceId: string): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), isNull(notes.deletedAt)))
      // `updated_at` alone is not a total order: it defaults to `now()`,
      // the transaction's start time, so everything written in one
      // transaction — an import, a batch MCP write — shares it exactly. Two
      // identical requests could then come back in different orders, which
      // in the explorer reads as items shuffling on their own. `created_at`
      // separates rows an import gave the same `updated_at`; `id` closes it.
      .orderBy(desc(notes.updatedAt), desc(notes.createdAt), desc(notes.id));
    return rows.map(toNote);
  }

  /** Trash bin view — opposite filter from `list`. */
  async listDeleted(spaceId: string): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), isNotNull(notes.deletedAt)))
      // Same reason, and more likely here: a bulk delete stamps every note
      // with one `deleted_at`.
      .orderBy(desc(notes.deletedAt), desc(notes.createdAt), desc(notes.id));
    return rows.map(toNote);
  }

  async update(id: string, patch: UpdateNotePatch, by?: WriteAttribution): Promise<Note | null> {
    // Version history lives HERE, at the one door every content write walks
    // through — REST PUT, MCP write, and the collab mirror (which goes
    // through the repo on purpose, bypassing NotesService). A caller-level
    // snapshot missed the collab path entirely; the write path itself cannot.
    let contentChanged = false;
    if (patch.contentMd !== undefined) {
      const [prev] = await this.db
        .select()
        .from(notes)
        .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
        .limit(1);
      if (prev && prev.contentMd !== patch.contentMd) {
        contentChanged = true;
        await this.versions.record(toNote(prev));
      }
    }
    const set: Partial<Row> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.contentMd !== undefined) set.contentMd = patch.contentMd;
    if (patch.folderId !== undefined) set.folderId = patch.folderId;
    const [row] = await this.db
      .update(notes)
      .set(set)
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
      .returning();
    if (!row) return null;
    const note = toNote(row);
    // Provenance is amended on every write (who touched it last, through which
    // door). The change statistic only advances on a CONTENT change: a retitle
    // or a move is not the note saying something different, and counting it
    // would teach the estimator that this note changes more often than it
    // does. Same rule the version history already applies.
    await this.provenance.record('note', note.id, note.spaceId, by ?? {});
    if (contentChanged) {
      await this.provenance.recordChange('note', note.id, note.spaceId);
    }
    return note;
  }

  /** SOFT delete — sets `deleted_at`. Returns true if the row existed AND
   *  wasn't already trashed (idempotent for repeated calls). */
  async delete(id: string): Promise<boolean> {
    const iso = new Date().toISOString();
    const rows = await this.db
      .update(notes)
      .set({ deletedAt: sql`${iso}::timestamp` })
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
      .returning({ id: notes.id });
    return rows.length > 0;
  }

  async setFavorite(id: string, value: boolean): Promise<Note | null> {
    const [row] = await this.db
      .update(notes)
      .set({ favorite: value, updatedAt: new Date() })
      .where(and(eq(notes.id, id), isNull(notes.deletedAt)))
      .returning();
    return row ? toNote(row) : null;
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const iso = new Date().toISOString();
    const rows = await this.db
      .update(notes)
      .set({ deletedAt: sql`${iso}::timestamp` })
      .where(and(inArray(notes.id, ids), isNull(notes.deletedAt)))
      .returning({ id: notes.id });
    return rows.length;
  }

  /** Clears `deleted_at`. Returns true if the row was in trash. */
  async restore(id: string): Promise<boolean> {
    const rows = await this.db
      .update(notes)
      .set({ deletedAt: null })
      .where(and(eq(notes.id, id), isNotNull(notes.deletedAt)))
      .returning({ id: notes.id });
    return rows.length > 0;
  }

  /** Hard delete a single note (must be in trash already — defense in depth). */
  async purge(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(notes)
      .where(and(eq(notes.id, id), isNotNull(notes.deletedAt)))
      .returning({ id: notes.id });
    return rows.length > 0;
  }

  /** Empty the trash for a workspace. Returns the count of purged rows. */
  async purgeTrashForSpace(spaceId: string): Promise<number> {
    const rows = await this.db
      .delete(notes)
      .where(and(eq(notes.spaceId, spaceId), isNotNull(notes.deletedAt)))
      .returning({ id: notes.id });
    return rows.length;
  }
}
