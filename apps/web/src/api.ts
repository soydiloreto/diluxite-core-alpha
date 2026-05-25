export interface Space {
  id: string;
  nombre: string;
}

export interface Note {
  id: string;
  espacioId: string;
  titulo: string;
  contenidoMd: string;
  creado?: string;
  modificado?: string;
}

export interface SearchResult {
  noteId: string;
  titulo: string;
  snippet: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface NoteRef {
  id: string;
  titulo: string;
}

export interface Graph {
  nodes: NoteRef[];
  edges: { source: string; target: string }[];
}

export interface TokenInfo {
  id: string;
  nombre: string;
  creado?: string;
}

export interface ApiClient {
  listSpaces(): Promise<Space[]>;
  listNotes(spaceId: string): Promise<Note[]>;
  notesByTag(spaceId: string, tag: string): Promise<Note[]>;
  createNote(spaceId: string, titulo: string, contenidoMd?: string): Promise<Note>;
  updateNote(id: string, patch: { titulo?: string; contenidoMd?: string }): Promise<Note>;
  appendNote(id: string, contenido: string): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  search(query: string, spaceId?: string): Promise<SearchResult[]>;
  listTags(spaceId: string): Promise<TagCount[]>;
  backlinks(noteId: string): Promise<NoteRef[]>;
  graph(spaceId: string): Promise<Graph>;
  mintToken(nombre: string): Promise<{ token: string } & TokenInfo>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
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
    listNotes: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/notes`).then((r) => json<Note[]>(r)),
    notesByTag: (spaceId, tag) =>
      fetch(`${base}/api/spaces/${spaceId}/notes?tag=${encodeURIComponent(tag)}`).then((r) =>
        json<Note[]>(r),
      ),
    createNote: (spaceId, titulo, contenidoMd = '') =>
      fetch(`${base}/api/spaces/${spaceId}/notes`, POST({ titulo, contenidoMd })).then((r) =>
        json<Note>(r),
      ),
    updateNote: (id, patch) =>
      fetch(`${base}/api/notes/${id}`, { ...POST(patch), method: 'PUT' }).then((r) => json<Note>(r)),
    appendNote: (id, contenido) =>
      fetch(`${base}/api/notes/${id}/append`, POST({ contenido })).then((r) => json<Note>(r)),
    deleteNote: (id) => fetch(`${base}/api/notes/${id}`, { method: 'DELETE' }).then(() => undefined),
    search: (query, spaceId) =>
      fetch(`${base}/api/search`, POST({ query, spaceId })).then((r) => json<SearchResult[]>(r)),
    listTags: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/tags`).then((r) => json<TagCount[]>(r)),
    backlinks: (noteId) => fetch(`${base}/api/notes/${noteId}/backlinks`).then((r) => json<NoteRef[]>(r)),
    graph: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/graph`).then((r) => json<Graph>(r)),
    mintToken: (nombre) =>
      fetch(`${base}/api/tokens`, POST({ nombre })).then((r) => json<{ token: string } & TokenInfo>(r)),
    listTokens: () => fetch(`${base}/api/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeToken: (id) => fetch(`${base}/api/tokens/${id}`, { method: 'DELETE' }).then(() => undefined),
  };
}
