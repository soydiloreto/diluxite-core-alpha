export interface Space {
  id: string;
  name: string;
}

export interface Note {
  id: string;
  spaceId: string;
  title: string;
  contentMd: string;
  folderId?: string | null;
  favorite?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Folder {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  createdAt?: string;
}

export interface SearchResult {
  noteId: string;
  title: string;
  snippet: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface NoteRef {
  id: string;
  title: string;
}

export interface Graph {
  nodes: NoteRef[];
  edges: { source: string; target: string }[];
}

export interface TokenInfo {
  id: string;
  name: string;
  createdAt?: string;
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';
export interface Info {
  embedder: string;
  version: string;
  user?: { email: string } | null;
}
export interface Stats {
  notes: number;
  links: number;
  tags: number;
}

export interface ApiClient {
  listSpaces(): Promise<Space[]>;
  listNotes(spaceId: string): Promise<Note[]>;
  notesByTag(spaceId: string, tag: string): Promise<Note[]>;
  createNote(spaceId: string, title: string, contentMd?: string, folderId?: string | null): Promise<Note>;
  updateNote(id: string, patch: { title?: string; contentMd?: string }): Promise<Note>;
  appendNote(id: string, content: string): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<{ deleted: number }>;
  setFavorite(id: string, value: boolean): Promise<Note>;
  listFolders(spaceId: string): Promise<Folder[]>;
  createFolder(spaceId: string, name: string, parentId?: string | null): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  moveFolder(id: string, parentId: string | null): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  search(query: string, spaceId?: string, mode?: SearchMode, topK?: number): Promise<SearchResult[]>;
  info(): Promise<Info>;
  stats(spaceId: string): Promise<Stats>;
  listTags(spaceId: string): Promise<TagCount[]>;
  backlinks(noteId: string): Promise<NoteRef[]>;
  graph(spaceId: string): Promise<Graph>;
  mintToken(name: string): Promise<{ token: string } & TokenInfo>;
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

/** HTTP client against the Core REST API. */
export function httpApi(base = ''): ApiClient {
  return {
    listSpaces: () => fetch(`${base}/api/spaces`).then((r) => json<Space[]>(r)),
    listNotes: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/notes`).then((r) => json<Note[]>(r)),
    notesByTag: (spaceId, tag) =>
      fetch(`${base}/api/spaces/${spaceId}/notes?tag=${encodeURIComponent(tag)}`).then((r) =>
        json<Note[]>(r),
      ),
    createNote: (spaceId, title, contentMd = '', folderId = null) =>
      fetch(`${base}/api/spaces/${spaceId}/notes`, POST({ title, contentMd, folderId })).then(
        (r) => json<Note>(r),
      ),
    updateNote: (id, patch) =>
      fetch(`${base}/api/notes/${id}`, { ...POST(patch), method: 'PUT' }).then((r) => json<Note>(r)),
    appendNote: (id, content) =>
      fetch(`${base}/api/notes/${id}/append`, POST({ content })).then((r) => json<Note>(r)),
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
    mintToken: (name) =>
      fetch(`${base}/api/tokens`, POST({ name })).then((r) => json<{ token: string } & TokenInfo>(r)),
    listTokens: () => fetch(`${base}/api/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeToken: (id) => fetch(`${base}/api/tokens/${id}`, { method: 'DELETE' }).then(() => undefined),
    deleteMany: (ids) =>
      fetch(`${base}/api/notes/delete-many`, POST({ ids })).then((r) => json<{ deleted: number }>(r)),
    setFavorite: (id, value) =>
      fetch(`${base}/api/notes/${id}/favorite`, { ...POST({ favorite: value }), method: 'PUT' }).then(
        (r) => json<Note>(r),
      ),
    listFolders: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/folders`).then((r) => json<Folder[]>(r)),
    createFolder: (spaceId, name, parentId = null) =>
      fetch(`${base}/api/spaces/${spaceId}/folders`, POST({ name, parentId })).then((r) =>
        json<Folder>(r),
      ),
    renameFolder: (id, name) =>
      fetch(`${base}/api/folders/${id}`, { ...POST({ name }), method: 'PUT' }).then((r) =>
        json<Folder>(r),
      ),
    moveFolder: (id, parentId) =>
      fetch(`${base}/api/folders/${id}`, { ...POST({ parentId }), method: 'PUT' }).then((r) =>
        json<Folder>(r),
      ),
    deleteFolder: (id) =>
      fetch(`${base}/api/folders/${id}`, { method: 'DELETE' }).then(() => undefined),
  };
}
