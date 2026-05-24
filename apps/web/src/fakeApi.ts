import type { ApiClient, Note, SearchResult, Space } from './api';

/** ApiClient en memoria para tests y demo offline. */
export function createFakeApi(opts?: { spaceId?: string }): ApiClient {
  const spaceId = opts?.spaceId ?? 'space-1';
  const spaces: Space[] = [{ id: spaceId, nombre: 'Mi espacio' }];
  const notes = new Map<string, Note>();
  let seq = 0;

  return {
    async listSpaces() {
      return spaces;
    },
    async listNotes(sid) {
      return [...notes.values()].filter((x) => x.espacioId === sid);
    },
    async createNote(sid, titulo, contenidoMd = '') {
      const note: Note = { id: `n${++seq}`, espacioId: sid, titulo, contenidoMd };
      notes.set(note.id, note);
      return { ...note };
    },
    async updateNote(id, patch) {
      const note = notes.get(id);
      if (!note) throw new Error('no existe');
      Object.assign(note, patch);
      return { ...note };
    },
    async deleteNote(id) {
      notes.delete(id);
    },
    async search(query) {
      const q = query.toLowerCase();
      return [...notes.values()]
        .filter((x) => x.titulo.toLowerCase().includes(q) || x.contenidoMd.toLowerCase().includes(q))
        .map<SearchResult>((x) => ({
          noteId: x.id,
          titulo: x.titulo,
          snippet: x.contenidoMd.slice(0, 100),
        }));
    },
  };
}
