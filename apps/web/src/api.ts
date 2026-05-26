export interface Space {
  id: string;
  nombre: string;
}

export interface Note {
  id: string;
  espacioId: string;
  titulo: string;
  contenidoMd: string;
  carpetaId?: string | null;
  favorita?: boolean;
  creado?: string;
  modificado?: string;
}

export interface Carpeta {
  id: string;
  espacioId: string;
  padreId: string | null;
  nombre: string;
  creado?: string;
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

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';
export interface Info {
  embedder: string;
  version: string;
  user?: { email: string } | null;
}
export interface Stats {
  notas: number;
  links: number;
  tags: number;
}

export interface ApiClient {
  listSpaces(): Promise<Space[]>;
  listNotes(spaceId: string): Promise<Note[]>;
  notesByTag(spaceId: string, tag: string): Promise<Note[]>;
  createNote(spaceId: string, titulo: string, contenidoMd?: string, carpetaId?: string | null): Promise<Note>;
  updateNote(id: string, patch: { titulo?: string; contenidoMd?: string }): Promise<Note>;
  appendNote(id: string, contenido: string): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<{ deleted: number }>;
  setFavorita(id: string, valor: boolean): Promise<Note>;
  listCarpetas(spaceId: string): Promise<Carpeta[]>;
  createCarpeta(spaceId: string, nombre: string, padreId?: string | null): Promise<Carpeta>;
  renameCarpeta(id: string, nombre: string): Promise<Carpeta>;
  moveCarpeta(id: string, padreId: string | null): Promise<Carpeta>;
  deleteCarpeta(id: string): Promise<void>;
  search(query: string, spaceId?: string, mode?: SearchMode, topK?: number): Promise<SearchResult[]>;
  info(): Promise<Info>;
  stats(spaceId: string): Promise<Stats>;
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
    createNote: (spaceId, titulo, contenidoMd = '', carpetaId = null) =>
      fetch(`${base}/api/spaces/${spaceId}/notes`, POST({ titulo, contenidoMd, carpetaId })).then(
        (r) => json<Note>(r),
      ),
    updateNote: (id, patch) =>
      fetch(`${base}/api/notes/${id}`, { ...POST(patch), method: 'PUT' }).then((r) => json<Note>(r)),
    appendNote: (id, contenido) =>
      fetch(`${base}/api/notes/${id}/append`, POST({ contenido })).then((r) => json<Note>(r)),
    deleteNote: (id) => fetch(`${base}/api/notes/${id}`, { method: 'DELETE' }).then(() => undefined),
    search: (query, spaceId, mode, topK) =>
      fetch(`${base}/api/search`, POST({ query, spaceId, mode, topK })).then((r) =>
        json<SearchResult[]>(r),
      ),
    info: () => fetch(`${base}/api/info`).then((r) => json<Info>(r)),
    stats: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/stats`).then((r) => json<Stats>(r)),
    listTags: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/tags`).then((r) => json<TagCount[]>(r)),
    backlinks: (noteId) => fetch(`${base}/api/notes/${noteId}/backlinks`).then((r) => json<NoteRef[]>(r)),
    graph: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/graph`).then((r) => json<Graph>(r)),
    mintToken: (nombre) =>
      fetch(`${base}/api/tokens`, POST({ nombre })).then((r) => json<{ token: string } & TokenInfo>(r)),
    listTokens: () => fetch(`${base}/api/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeToken: (id) => fetch(`${base}/api/tokens/${id}`, { method: 'DELETE' }).then(() => undefined),
    deleteMany: (ids) =>
      fetch(`${base}/api/notes/delete-many`, POST({ ids })).then((r) => json<{ deleted: number }>(r)),
    setFavorita: (id, valor) =>
      fetch(`${base}/api/notes/${id}/favorita`, { ...POST({ favorita: valor }), method: 'PUT' }).then(
        (r) => json<Note>(r),
      ),
    listCarpetas: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/carpetas`).then((r) => json<Carpeta[]>(r)),
    createCarpeta: (spaceId, nombre, padreId = null) =>
      fetch(`${base}/api/spaces/${spaceId}/carpetas`, POST({ nombre, padreId })).then((r) =>
        json<Carpeta>(r),
      ),
    renameCarpeta: (id, nombre) =>
      fetch(`${base}/api/carpetas/${id}`, { ...POST({ nombre }), method: 'PUT' }).then((r) =>
        json<Carpeta>(r),
      ),
    moveCarpeta: (id, padreId) =>
      fetch(`${base}/api/carpetas/${id}`, { ...POST({ padreId }), method: 'PUT' }).then((r) =>
        json<Carpeta>(r),
      ),
    deleteCarpeta: (id) =>
      fetch(`${base}/api/carpetas/${id}`, { method: 'DELETE' }).then(() => undefined),
  };
}
