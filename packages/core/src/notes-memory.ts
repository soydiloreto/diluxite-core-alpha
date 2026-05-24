import { randomUUID } from 'node:crypto';
import type { Note, NotesRepository, CreateNoteInput, UpdateNotePatch } from './notes';

/** Repositorio en memoria — para tests y prototipado. La persistencia real vive en @diluxite/db. */
export class InMemoryNotesRepository implements NotesRepository {
  private notes = new Map<string, Note>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(input: Required<CreateNoteInput>): Promise<Note> {
    const ts = this.now();
    const note: Note = {
      id: randomUUID(),
      espacioId: input.espacioId,
      titulo: input.titulo,
      contenidoMd: input.contenidoMd,
      creado: ts,
      modificado: ts,
    };
    this.notes.set(note.id, note);
    return structuredClone(note);
  }

  async findById(id: string): Promise<Note | null> {
    const n = this.notes.get(id);
    return n ? structuredClone(n) : null;
  }

  async findByTitulo(espacioId: string, titulo: string): Promise<Note | null> {
    for (const n of this.notes.values()) {
      if (n.espacioId === espacioId && n.titulo === titulo) return structuredClone(n);
    }
    return null;
  }

  async list(espacioId: string): Promise<Note[]> {
    return [...this.notes.values()]
      .filter((n) => n.espacioId === espacioId)
      .sort((a, b) => b.modificado.getTime() - a.modificado.getTime())
      .map((n) => structuredClone(n));
  }

  async update(id: string, patch: UpdateNotePatch): Promise<Note | null> {
    const n = this.notes.get(id);
    if (!n) return null;
    if (patch.titulo !== undefined) n.titulo = patch.titulo;
    if (patch.contenidoMd !== undefined) n.contenidoMd = patch.contenidoMd;
    n.modificado = this.now();
    return structuredClone(n);
  }

  async delete(id: string): Promise<boolean> {
    return this.notes.delete(id);
  }
}
