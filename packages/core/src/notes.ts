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
}

/** Persistence port (in-memory for tests, Postgres in @diluxite/db). */
export interface NotesRepository {
  create(input: CreateNoteInput): Promise<Note>;
  findById(id: string): Promise<Note | null>;
  findByTitle(spaceId: string, title: string): Promise<Note | null>;
  list(spaceId: string): Promise<Note[]>;
  update(id: string, patch: UpdateNotePatch): Promise<Note | null>;
  delete(id: string): Promise<boolean>;
  setFavorite(id: string, value: boolean): Promise<Note | null>;
  deleteMany(ids: string[]): Promise<number>;
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

  deleteManyIds(ids: string[]): Promise<number> {
    return this.repo.deleteMany(ids);
  }

  get(id: string): Promise<Note | null> {
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

  async delete(id: string): Promise<boolean> {
    const ok = await this.repo.delete(id);
    if (ok) await this.indexer?.remove(id);
    return ok;
  }

  /** Open a note by title; if missing, create it (wikilink follow behaviour). */
  async openOrCreate(spaceId: string, title: string): Promise<Note> {
    const existing = await this.repo.findByTitle(spaceId, title);
    if (existing) return existing;
    return this.create({ spaceId, title, contentMd: `# ${title}\n\n` });
  }

  /** Wikilink targets emitted by a note. */
  outgoingLinks(note: Note): string[] {
    return uniqueTargets(note.contentMd);
  }
}
