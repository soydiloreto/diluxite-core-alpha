import { uniqueTargets } from './wikilinks';

export interface Note {
  id: string;
  spaceId: string;
  title: string;
  contentMd: string;
  createdAt: Date;
  updatedAt: Date;
  folderId: string | null;
  favorite: boolean;
}

export interface CreateNoteInput {
  spaceId: string;
  title: string;
  contentMd?: string;
  folderId?: string | null;
}

export interface UpdateNotePatch {
  title?: string;
  contentMd?: string;
  /** Move the note to a folder (or to root with `null`). Omit to leave it where it is. */
  folderId?: string | null;
}

/**
 * Persistence port (in-memory for tests, Postgres in @diluxite/db).
 *
 * Trash bin contract (alpha.43):
 *   - `delete` / `deleteMany` are SOFT — sets `deletedAt`. Reads exclude
 *     trashed rows.
 *   - `listDeleted` powers the trash UI.
 *   - `restore` flips the flag back.
 *   - `purge` / `purgeTrashForSpace` are the only paths that drop rows.
 *
 * The trash methods are optional in the interface so older callers (e.g.
 * the in-memory NotesMemoryRepository used in core unit tests) don't break.
 * Code that needs them (the trash endpoints, the empty-trash UI) checks
 * presence + throws a clear error in test contexts where it's missing.
 */
export interface NotesRepository {
  create(input: CreateNoteInput): Promise<Note>;
  findById(id: string): Promise<Note | null>;
  findByTitle(spaceId: string, title: string): Promise<Note | null>;
  list(spaceId: string): Promise<Note[]>;
  update(id: string, patch: UpdateNotePatch): Promise<Note | null>;
  delete(id: string): Promise<boolean>;
  setFavorite(id: string, value: boolean): Promise<Note | null>;
  deleteMany(ids: string[]): Promise<number>;
  listDeleted?(spaceId: string): Promise<Note[]>;
  restore?(id: string): Promise<boolean>;
  purge?(id: string): Promise<boolean>;
  purgeTrashForSpace?(spaceId: string): Promise<number>;
  findByIdIncludingDeleted?(id: string): Promise<Note | null>;
  /**
   * Atomic "get-or-create by title". Returns the existing live note with this
   * (spaceId, title) or inserts+returns a new one, racing-safely (relies on a
   * UNIQUE index on `(space_id, title) WHERE deleted_at IS NULL`). Optional so
   * in-memory repos used by unit tests don't have to implement it; the service
   * falls back to the non-atomic find-then-create path when absent.
   *
   * `created` tells the caller whether a row was actually inserted (so it can
   * index only on first creation, not on every wikilink follow).
   */
  createIfAbsent?(input: CreateNoteInput): Promise<{ note: Note; created: boolean }>;
}

/** Indexing port for search (chunk + embed). No-op in CRUD-only tests. */
export interface NoteIndexer {
  index(note: Note): Promise<void>;
  remove(noteId: string): Promise<void>;
}

export class NotesService {
  constructor(
    private readonly repo: NotesRepository,
    private readonly indexer?: NoteIndexer,
  ) {}

  async create(input: CreateNoteInput): Promise<Note> {
    const note = await this.repo.create({
      spaceId: input.spaceId,
      title: input.title,
      contentMd: input.contentMd ?? '',
      folderId: input.folderId ?? null,
    });
    await this.indexer?.index(note);
    return note;
  }

  setFavorite(id: string, value: boolean): Promise<Note | null> {
    return this.repo.setFavorite(id, value);
  }

  async deleteManyIds(ids: string[]): Promise<number> {
    const n = await this.repo.deleteMany(ids);
    // Same symmetry as single delete: wipe each note's derived rows (chunks,
    // tags, links). Idempotent for ids that weren't actually trashed.
    if (this.indexer) {
      for (const id of ids) await this.indexer.remove(id);
    }
    return n;
  }

  get(id: string): Promise<Note | null> {
    return this.repo.findById(id);
  }

  /** For the trash endpoints — `get` would return null for soft-deleted rows. */
  getIncludingTrashed(id: string): Promise<Note | null> {
    if (this.repo.findByIdIncludingDeleted) {
      return this.repo.findByIdIncludingDeleted(id);
    }
    // In-memory repos that don't support trash: same as `get`.
    return this.repo.findById(id);
  }

  list(spaceId: string): Promise<Note[]> {
    return this.repo.list(spaceId);
  }

  async update(id: string, patch: UpdateNotePatch): Promise<Note | null> {
    const note = await this.repo.update(id, patch);
    if (note) await this.indexer?.index(note);
    return note;
  }

  /**
   * Soft delete (alpha.43). The note disappears from listings + search but
   * survives in trash. We also drop the indexed chunks so searches stop
   * returning it; on restore the indexer re-chunks from contentMd.
   */
  async delete(id: string): Promise<boolean> {
    const ok = await this.repo.delete(id);
    if (ok) await this.indexer?.remove(id);
    return ok;
  }

  /** Trash bin listing for the UI. Errors if the repo doesn't support trash. */
  listDeleted(spaceId: string): Promise<Note[]> {
    if (!this.repo.listDeleted) {
      throw new Error('this repository does not implement trash');
    }
    return this.repo.listDeleted(spaceId);
  }

  /** Restore a soft-deleted note. Re-indexes so search finds it again. */
  async restore(id: string): Promise<Note | null> {
    if (!this.repo.restore) {
      throw new Error('this repository does not implement trash');
    }
    const ok = await this.repo.restore(id);
    if (!ok) return null;
    const note = await this.repo.findById(id);
    if (note) await this.indexer?.index(note);
    return note;
  }

  /** Hard delete a single trashed note. */
  async purge(id: string): Promise<boolean> {
    if (!this.repo.purge) {
      throw new Error('this repository does not implement trash');
    }
    return this.repo.purge(id);
  }

  /** Empty the trash for a workspace. Returns the count of purged rows. */
  async purgeTrashForSpace(spaceId: string): Promise<number> {
    if (!this.repo.purgeTrashForSpace) {
      throw new Error('this repository does not implement trash');
    }
    return this.repo.purgeTrashForSpace(spaceId);
  }

  /**
   * Open a note by title; if missing, create it (wikilink follow behaviour).
   * `folderId` only applies to a note this call creates — an existing note
   * stays where the user filed it, so writing to it never moves it behind
   * their back.
   */
  async openOrCreate(spaceId: string, title: string, folderId: string | null = null): Promise<Note> {
    const contentMd = `# ${title}\n\n`;
    // Atomic path: the repo's UNIQUE(space_id, title) index makes concurrent
    // wikilink follows of the same title converge on one row (no TOCTOU
    // duplicate). Only index when WE created the row.
    if (this.repo.createIfAbsent) {
      const { note, created } = await this.repo.createIfAbsent({
        spaceId,
        title,
        contentMd,
        folderId,
      });
      if (created) await this.indexer?.index(note);
      return note;
    }
    // Fallback for repos without the atomic upsert (in-memory unit tests).
    const existing = await this.repo.findByTitle(spaceId, title);
    if (existing) return existing;
    return this.create({ spaceId, title, contentMd, folderId });
  }

  /** Wikilink targets emitted by a note. */
  outgoingLinks(note: Note): string[] {
    return uniqueTargets(note.contentMd);
  }
}
