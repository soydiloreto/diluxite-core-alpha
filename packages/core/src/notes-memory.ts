import { randomUUID } from 'node:crypto';
import type { Note, NotesRepository, CreateNoteInput, UpdateNotePatch } from './notes';

/** In-memory repository — used for tests and prototyping. Real persistence lives in @diluxite/db. */
export class InMemoryNotesRepository implements NotesRepository {
  private notes = new Map<string, Note>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: CreateNoteInput): Promise<Note> {
    const ts = this.now();
    const note: Note = {
      id: randomUUID(),
      spaceId: input.spaceId,
      title: input.title,
      contentMd: input.contentMd ?? '',
      folderId: input.folderId ?? null,
      favorite: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.notes.set(note.id, note);
    return structuredClone(note);
  }

  async findById(id: string): Promise<Note | null> {
    const n = this.notes.get(id);
    return n ? structuredClone(n) : null;
  }

  async findByTitle(spaceId: string, title: string): Promise<Note | null> {
    for (const n of this.notes.values()) {
      if (n.spaceId === spaceId && n.title === title) return structuredClone(n);
    }
    return null;
  }

  async list(spaceId: string): Promise<Note[]> {
    return [...this.notes.values()]
      .filter((n) => n.spaceId === spaceId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((n) => structuredClone(n));
  }

  async update(id: string, patch: UpdateNotePatch): Promise<Note | null> {
    const n = this.notes.get(id);
    if (!n) return null;
    if (patch.title !== undefined) n.title = patch.title;
    if (patch.contentMd !== undefined) n.contentMd = patch.contentMd;
    n.updatedAt = this.now();
    return structuredClone(n);
  }

  async delete(id: string): Promise<boolean> {
    return this.notes.delete(id);
  }

  async setFavorite(id: string, value: boolean): Promise<Note | null> {
    const n = this.notes.get(id);
    if (!n) return null;
    n.favorite = value;
    n.updatedAt = this.now();
    return structuredClone(n);
  }

  async deleteMany(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) if (this.notes.delete(id)) count++;
    return count;
  }
}
