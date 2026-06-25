import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from './client';
import { folders, notes } from './schema';

/**
 * Raised when a folder move would create a cycle — moving a folder into itself
 * or into one of its own descendants. The whole batch is rejected (the move is
 * atomic), so the caller surfaces a single clear error instead of a half-done
 * reparent.
 */
export class FolderCycleError extends Error {
  constructor(message = 'a folder cannot be moved into itself or one of its descendants') {
    super(message);
    this.name = 'FolderCycleError';
  }
}

export interface MoveItemsInput {
  /** Items are scoped to this space; ids from other spaces are never touched. */
  spaceId: string;
  /** Destination folder, or `null` for the space root. */
  targetFolderId: string | null;
  noteIds: string[];
  folderIds: string[];
}

export interface MoveItemsResult {
  movedNotes: number;
  movedFolders: number;
}

/**
 * Atomic bulk move of notes and folders into a single destination folder (or
 * the root). Notes and folders live in different tables, so a multi-select move
 * spans both — running it in ONE transaction makes it all-or-nothing: a cycle
 * (or any failure) rolls the whole thing back, never leaving a half-moved tree.
 *
 * Security: every UPDATE is scoped to `spaceId`, so a caller authorised for one
 * space can't move another space's items by smuggling foreign ids in the body.
 */
export class DrizzleMoveRepository {
  constructor(private readonly db: Db) {}

  async moveItems(input: MoveItemsInput): Promise<MoveItemsResult> {
    const { spaceId, targetFolderId } = input;
    const noteIds = [...new Set(input.noteIds)];
    const folderIds = [...new Set(input.folderIds)];
    if (noteIds.length === 0 && folderIds.length === 0) {
      return { movedNotes: 0, movedFolders: 0 };
    }

    return this.db.transaction(async (tx) => {
      // Load the space's folder tree once (id → parentId) for validation.
      const all = await tx
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .where(eq(folders.spaceId, spaceId));
      const parentOf = new Map(all.map((f) => [f.id, f.parentId]));

      // The destination, when given, must be a real folder in THIS space.
      if (targetFolderId !== null && !parentOf.has(targetFolderId)) {
        throw new FolderCycleError('target folder does not belong to this space');
      }

      // Cycle guard: walk the destination's ancestor chain up to the root. If
      // any folder being moved appears on that path (or IS the destination),
      // the move would graft a subtree onto itself.
      if (folderIds.length > 0 && targetFolderId !== null) {
        const moving = new Set(folderIds);
        const seen = new Set<string>();
        let cur: string | null = targetFolderId;
        while (cur !== null) {
          if (moving.has(cur)) throw new FolderCycleError();
          if (seen.has(cur)) break; // defensive: pre-existing cycle — stop walking
          seen.add(cur);
          cur = parentOf.get(cur) ?? null;
        }
      }

      let movedFolders = 0;
      if (folderIds.length > 0) {
        const rows = await tx
          .update(folders)
          .set({ parentId: targetFolderId })
          .where(and(inArray(folders.id, folderIds), eq(folders.spaceId, spaceId)))
          .returning({ id: folders.id });
        movedFolders = rows.length;
      }

      let movedNotes = 0;
      if (noteIds.length > 0) {
        const rows = await tx
          .update(notes)
          .set({ folderId: targetFolderId, updatedAt: new Date() })
          .where(
            and(
              inArray(notes.id, noteIds),
              eq(notes.spaceId, spaceId),
              isNull(notes.deletedAt),
            ),
          )
          .returning({ id: notes.id });
        movedNotes = rows.length;
      }

      return { movedNotes, movedFolders };
    });
  }
}
