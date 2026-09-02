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
  /**
   * When the note was archived, or null while it is live (migration 0035).
   *
   * Archived is NOT a third state next to trashed: the note stays a first
   * class citizen of the memory. It leaves the tree and the recents, and it
   * keeps answering search and MCP — marked, and ranked below live notes.
   */
  archivedAt: Date | null;
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
/**
 * Who and what produced a write — ADR-002's PROV-O axis, carried from the
 * layer that KNOWS the identity down to the one door every write goes
 * through.
 *
 * Optional at every call site on purpose, and the default is `unknown` rather
 * than a guess. The collab mirror writes through the repository directly and
 * its flush is authored by whoever typed during the debounce — possibly
 * several people. Naming one of them would be inventing provenance, which is
 * the exact failure the record exists to prevent.
 */
export interface WriteAttribution {
  /** The PROV Agent: a user id, or null when the path cannot name one. */
  attributedTo?: string | null;
  agentKind?: 'user' | 'org_token' | 'connector' | 'system' | 'unknown';
  /** The PROV Activity: which door this came through. */
  generatedBy?: string;
  derivedFromNoteId?: string | null;
  derivedFromLine?: number | null;
  derivedFromRef?: string | null;
}

export interface NotesRepository {
  create(input: CreateNoteInput, by?: WriteAttribution): Promise<Note>;
  findById(id: string): Promise<Note | null>;
  findByTitle(spaceId: string, title: string): Promise<Note | null>;
  list(spaceId: string): Promise<Note[]>;
  update(id: string, patch: UpdateNotePatch, by?: WriteAttribution): Promise<Note | null>;
  delete(id: string): Promise<boolean>;
  setFavorite(id: string, value: boolean): Promise<Note | null>;
  /** Archive (`true`) or bring back (`false`). Null when the note is not live. */
  setArchived(id: string, value: boolean): Promise<Note | null>;
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

// ── Version history ─────────────────────────────────────────────────────

/** One immutable snapshot of a note's content as it was BEFORE a save. */
export interface NoteVersion {
  id: string;
  noteId: string;
  spaceId: string;
  title: string;
  contentMd: string;
  createdAt: Date;
}

/** A listing row — everything but the (potentially large) content. */
export type NoteVersionMeta = Omit<NoteVersion, 'contentMd'>;

/**
 * How often a burst of saves collapses into one version. Collab flushes every
 * ~2s and the editor saves on blur — without coalescing, an editing session
 * would mint hundreds of near-identical snapshots. Within this window the
 * FIRST snapshot wins (it holds the state before the burst began), and later
 * saves record nothing.
 */
export const VERSION_COALESCE_MS = 5 * 60 * 1000;

/**
 * Upper bound of versions kept per note. `record` prunes beyond it, oldest
 * first — history is a safety net with a bounded cost, not an archive.
 */
export const VERSION_CAP = 100;

/**
 * Persistence port for note version history (Postgres in @diluxite/db).
 * Optional on NotesService so CRUD-only unit tests and older wirings keep
 * working — when absent, saves simply record no history.
 */
export interface NoteVersionsRepository {
  /**
   * Snapshot `prev` (the note's state before an update), applying the
   * coalescing window and the per-note cap. Returns the stored version, or
   * null when the save coalesced into an existing recent snapshot.
   */
  record(
    prev: Note,
    opts?: { coalesceMs?: number; cap?: number },
  ): Promise<NoteVersion | null>;
  /** Newest first. Content is included; callers slim to meta when listing. */
  listForNote(noteId: string, limit?: number): Promise<NoteVersion[]>;
  findById(versionId: string): Promise<NoteVersion | null>;
}

export class NotesService {
  constructor(
    private readonly repo: NotesRepository,
    private readonly indexer?: NoteIndexer,
    private readonly versions?: NoteVersionsRepository,
  ) {}

  async create(input: CreateNoteInput, by?: WriteAttribution): Promise<Note> {
    const note = await this.repo.create(
      {
        spaceId: input.spaceId,
        title: input.title,
        contentMd: input.contentMd ?? '',
        folderId: input.folderId ?? null,
      },
      by,
    );
    await this.indexer?.index(note);
    return note;
  }

  setFavorite(id: string, value: boolean): Promise<Note | null> {
    return this.repo.setFavorite(id, value);
  }

  /**
   * Archive a note, or bring it back.
   *
   * Nothing is re-indexed: an archived note keeps its chunks, tags and links,
   * because it keeps answering searches. That is the line between archiving
   * and the trash, which wipes everything derived.
   */
  setArchived(id: string, value: boolean): Promise<Note | null> {
    return this.repo.setArchived(id, value);
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

  async update(id: string, patch: UpdateNotePatch, by?: WriteAttribution): Promise<Note | null> {
    // Version snapshots are NOT taken here: the collab mirror writes through
    // the repository directly (on purpose), so a service-level snapshot would
    // miss the most common save path. The Drizzle repository records history
    // inside its own `update` — the one door every content write walks
    // through. This service only READS history (list/get/restore below).
    const note = await this.repo.update(id, patch, by);
    if (note) await this.indexer?.index(note);
    return note;
  }

  /** Version history for a note, newest first, content omitted. */
  async listVersions(noteId: string, limit = 50): Promise<NoteVersionMeta[]> {
    if (!this.versions) return [];
    const rows = await this.versions.listForNote(noteId, limit);
    return rows.map(({ contentMd: _content, ...meta }) => meta);
  }

  /** One full version (content included), or null. */
  getVersion(versionId: string): Promise<NoteVersion | null> {
    if (!this.versions) return Promise.resolve(null);
    return this.versions.findById(versionId);
  }

  /**
   * Restore = a NEW save with the old content. The current state gets its own
   * snapshot first (via `update`), so restoring never erases history — you
   * can restore a restore.
   */
  async restoreVersion(noteId: string, versionId: string): Promise<Note | null> {
    const version = await this.getVersion(versionId);
    if (!version || version.noteId !== noteId) return null;
    return this.update(noteId, { contentMd: version.contentMd });
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
    return (await this.openOrCreateDetailed(spaceId, title, folderId)).note;
  }

  /**
   * openOrCreate, but saying whether the row is new. A bulk writer has to
   * report created vs updated per item — "saved 12 notes" hides that eleven
   * were overwrites.
   */
  async openOrCreateDetailed(
    spaceId: string,
    title: string,
    folderId: string | null = null,
  ): Promise<{ note: Note; created: boolean }> {
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
      return { note, created };
    }
    // Fallback for repos without the atomic upsert (in-memory unit tests).
    const existing = await this.repo.findByTitle(spaceId, title);
    if (existing) return { note: existing, created: false };
    return { note: await this.create({ spaceId, title, contentMd, folderId }), created: true };
  }

  /** Wikilink targets emitted by a note. */
  outgoingLinks(note: Note): string[] {
    return uniqueTargets(note.contentMd);
  }
}
