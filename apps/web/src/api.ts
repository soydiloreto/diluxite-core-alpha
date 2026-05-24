export interface Space {
  id: string;
  nombre: string;
}

export interface Note {
  id: string;
  espacioId: string;
  titulo: string;
  contenidoMd: string;
}

export interface SearchResult {
  noteId: string;
  titulo: string;
  snippet: string;
}

export interface ApiClient {
  listSpaces(): Promise<Space[]>;
  listNotes(spaceId: string): Promise<Note[]>;
  createNote(spaceId: string, titulo: string, contenidoMd?: string): Promise<Note>;
  updateNote(id: string, patch: { titulo?: string; contenidoMd?: string }): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  search(query: string, spaceId?: string): Promise<SearchResult[]>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const POST = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Cliente HTTP contra la REST API del Core. */
export function httpApi(base = ''): ApiClient {
  return {
    listSpaces: () => fetch(`${base}/api/spaces`).then((r) => json<Space[]>(r)),
    listNotes: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/notes`).then((r) => json<Note[]>(r)),
    createNote: (spaceId, titulo, contenidoMd = '') =>
      fetch(`${base}/api/spaces/${spaceId}/notes`, POST({ titulo, contenidoMd })).then((r) =>
        json<Note>(r),
      ),
    updateNote: (id, patch) =>
      fetch(`${base}/api/notes/${id}`, { ...POST(patch), method: 'PUT' }).then((r) => json<Note>(r)),
    deleteNote: (id) =>
      fetch(`${base}/api/notes/${id}`, { method: 'DELETE' }).then(() => undefined),
    search: (query, spaceId) =>
      fetch(`${base}/api/search`, POST({ query, spaceId })).then((r) => json<SearchResult[]>(r)),
  };
}
