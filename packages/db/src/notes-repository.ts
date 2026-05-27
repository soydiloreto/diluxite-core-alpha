import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  Note,
  NotesRepository,
  CreateNoteInput,
  UpdateNotePatch,
} from '@diluxite/core';
import type { Db } from './client';
import { notes } from './schema';

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

export class DrizzleNotesRepository implements NotesRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateNoteInput): Promise<Note> {
    const [row] = await this.db
      .insert(notes)
      .values({
        spaceId: input.spaceId,
        title: input.title,
        contentMd: input.contentMd ?? '',
        folderId: input.folderId ?? null,
      })
      .returning();
    return toNote(row);
  }

  async findById(id: string): Promise<Note | null> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id));
    return row ? toNote(row) : null;
  }

  async findByTitle(spaceId: string, title: string): Promise<Note | null> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.spaceId, spaceId), eq(notes.title, title)));
    return row ? toNote(row) : null;
  }

  async list(spaceId: string): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notes)
      .where(eq(notes.spaceId, spaceId))
      .orderBy(desc(notes.updatedAt));
    return rows.map(toNote);
  }

  async update(id: string, patch: UpdateNotePatch): Promise<Note | null> {
    const set: Partial<Row> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.contentMd !== undefined) set.contentMd = patch.contentMd;
    if (patch.folderId !== undefined) set.folderId = patch.folderId;
    const [row] = await this.db
      .update(notes)
      .set(set)
      .where(eq(notes.id, id))
      .returning();
    return row ? toNote(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(notes)
      .where(eq(notes.id, id))
      .returning({ id: notes.id });
    return rows.length > 0;
  }

  async setFavorite(id: string, value: boolean): Promise<Note | null> {
    const [row] = await this.db
      .update(notes)
      .set({ favorite: value, updatedAt: new Date() })
      .where(eq(notes.id, id))
      .returning();
    return row ? toNote(row) : null;
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db
      .delete(notes)
      .where(inArray(notes.id, ids))
      .returning({ id: notes.id });
    return rows.length;
  }
}
