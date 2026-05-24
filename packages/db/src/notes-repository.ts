import { and, desc, eq } from 'drizzle-orm';
import type {
  Note,
  NotesRepository,
  CreateNoteInput,
  UpdateNotePatch,
} from '@diluxite/core';
import type { Db } from './client';
import { notas } from './schema';

type Row = typeof notas.$inferSelect;

function toNote(row: Row): Note {
  return {
    id: row.id,
    espacioId: row.espacioId,
    titulo: row.titulo,
    contenidoMd: row.contenidoMd,
    creado: row.creado,
    modificado: row.modificado,
  };
}

export class DrizzleNotesRepository implements NotesRepository {
  constructor(private readonly db: Db) {}

  async create(input: Required<CreateNoteInput>): Promise<Note> {
    const [row] = await this.db
      .insert(notas)
      .values({
        espacioId: input.espacioId,
        titulo: input.titulo,
        contenidoMd: input.contenidoMd,
      })
      .returning();
    return toNote(row);
  }

  async findById(id: string): Promise<Note | null> {
    const [row] = await this.db.select().from(notas).where(eq(notas.id, id));
    return row ? toNote(row) : null;
  }

  async findByTitulo(espacioId: string, titulo: string): Promise<Note | null> {
    const [row] = await this.db
      .select()
      .from(notas)
      .where(and(eq(notas.espacioId, espacioId), eq(notas.titulo, titulo)));
    return row ? toNote(row) : null;
  }

  async list(espacioId: string): Promise<Note[]> {
    const rows = await this.db
      .select()
      .from(notas)
      .where(eq(notas.espacioId, espacioId))
      .orderBy(desc(notas.modificado));
    return rows.map(toNote);
  }

  async update(id: string, patch: UpdateNotePatch): Promise<Note | null> {
    const set: Partial<Row> = { modificado: new Date() };
    if (patch.titulo !== undefined) set.titulo = patch.titulo;
    if (patch.contenidoMd !== undefined) set.contenidoMd = patch.contenidoMd;
    const [row] = await this.db
      .update(notas)
      .set(set)
      .where(eq(notas.id, id))
      .returning();
    return row ? toNote(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(notas)
      .where(eq(notas.id, id))
      .returning({ id: notas.id });
    return rows.length > 0;
  }
}
