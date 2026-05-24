import { uniqueTargets } from './wikilinks';

export interface Note {
  id: string;
  espacioId: string;
  titulo: string;
  contenidoMd: string;
  creado: Date;
  modificado: Date;
}

export interface CreateNoteInput {
  espacioId: string;
  titulo: string;
  contenidoMd?: string;
}

export interface UpdateNotePatch {
  titulo?: string;
  contenidoMd?: string;
}

/** Puerto de persistencia (implementado en memoria para tests y en Postgres en @diluxite/db). */
export interface NotesRepository {
  create(input: Required<CreateNoteInput>): Promise<Note>;
  findById(id: string): Promise<Note | null>;
  findByTitulo(espacioId: string, titulo: string): Promise<Note | null>;
  list(espacioId: string): Promise<Note[]>;
  update(id: string, patch: UpdateNotePatch): Promise<Note | null>;
  delete(id: string): Promise<boolean>;
}

/** Puerto de indexado para búsqueda (chunk + embed). No-op en tests de CRUD. */
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
      espacioId: input.espacioId,
      titulo: input.titulo,
      contenidoMd: input.contenidoMd ?? '',
    });
    await this.indexer?.index(note);
    return note;
  }

  get(id: string): Promise<Note | null> {
    return this.repo.findById(id);
  }

  list(espacioId: string): Promise<Note[]> {
    return this.repo.list(espacioId);
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

  /** Abre la nota por título; si no existe, la crea (comportamiento de wikilink). */
  async openOrCreate(espacioId: string, titulo: string): Promise<Note> {
    const existing = await this.repo.findByTitulo(espacioId, titulo);
    if (existing) return existing;
    return this.create({ espacioId, titulo, contenidoMd: `# ${titulo}\n\n` });
  }

  /** Targets de wikilinks que salen de una nota. */
  outgoingLinks(note: Note): string[] {
    return uniqueTargets(note.contenidoMd);
  }
}
