export interface Space {
  id: string;
  orgId?: string;
  name: string;
}

export type OrgRole = 'super_admin' | 'admin' | 'member';
export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt?: string;
}

export interface OrganizationWithRole extends Organization {
  role: OrgRole;
}

export interface OrgMember {
  userId: string;
  email: string;
  role: OrgRole;
  joinedAt?: string;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  role: WorkspaceRole;
  joinedAt?: string;
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

export interface GraphNode {
  id: string;
  title: string;
  /** Folder id (null = root). Used to colour-cluster the graph view. */
  folderId: string | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: { source: string; target: string }[];
}

export interface TokenInfo {
  id: string;
  name: string;
  createdAt?: string;
  /** Empty for legacy user tokens; non-empty for org tokens. */
  scopes?: string[];
}

/** Granular scopes recognised by org tokens. */
export type TokenScope = 'read' | 'write' | 'admin' | `space:${string}` | `org:${string}`;

export interface PasskeyInfo {
  id: string;
  label: string;
  deviceType: string | null;
  createdAt?: string;
  lastUsedAt?: string | null;
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';
export interface Info {
  embedder: string;
  version: string;
  authMode?: 'local' | 'server';
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
  updateNote(id: string, patch: { title?: string; contentMd?: string; folderId?: string | null }): Promise<Note>;
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
  /** Notes semantically close to this one (pgvector cosine). */
  related(noteId: string, limit?: number): Promise<(NoteRef & { distance: number })[]>;
  graph(spaceId: string): Promise<Graph>;
  mintToken(name: string): Promise<{ token: string } & TokenInfo>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
  // Server-mode auth (no-op in local mode — returns ok=true unconditionally
  // because the SingleUserAuthProvider has no login concept).
  login(email: string, password: string): Promise<{ ok: true; user: { id: string; email: string } }>;
  logout(): Promise<void>;
  // WebAuthn / passkeys (server mode only).
  listPasskeys(): Promise<PasskeyInfo[]>;
  registerPasskey(label?: string): Promise<{ ok: true }>;
  revokePasskey(id: string): Promise<void>;
  /** Triggers the browser's WebAuthn auth ceremony + mints a session cookie. */
  signInWithPasskey(): Promise<{ ok: true }>;
  // Org tokens (with scopes) — only org admins can manage these.
  mintOrgToken(
    orgId: string,
    name: string,
    scopes: TokenScope[],
  ): Promise<{ token: string } & TokenInfo>;
  listOrgTokens(orgId: string): Promise<TokenInfo[]>;
  revokeOrgToken(orgId: string, id: string): Promise<void>;
  // Organizations
  listOrganizations(): Promise<OrganizationWithRole[]>;
  createOrganization(name: string, slug?: string): Promise<Organization>;
  renameOrganization(id: string, name: string): Promise<void>;
  deleteOrganization(id: string): Promise<void>;
  listOrgMembers(orgId: string): Promise<OrgMember[]>;
  addOrgMember(orgId: string, email: string, role: OrgRole): Promise<{ ok: true; userId: string; role: OrgRole }>;
  updateOrgMember(orgId: string, userId: string, role: OrgRole): Promise<void>;
  removeOrgMember(orgId: string, userId: string): Promise<void>;
  listOrgWorkspaces(orgId: string): Promise<Space[]>;
  createWorkspace(orgId: string, name: string): Promise<Space>;
  renameWorkspace(spaceId: string, name: string): Promise<void>;
  deleteWorkspace(spaceId: string): Promise<void>;
  listWorkspaceMembers(spaceId: string): Promise<WorkspaceMember[]>;
  addWorkspaceMember(spaceId: string, email: string, role: WorkspaceRole): Promise<{ ok: true; userId: string; role: WorkspaceRole }>;
  updateWorkspaceMember(spaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  removeWorkspaceMember(spaceId: string, userId: string): Promise<void>;
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
    related: (noteId, limit = 10) =>
      fetch(`${base}/api/notes/${noteId}/related?limit=${limit}`).then((r) =>
        json<(NoteRef & { distance: number })[]>(r),
      ),
    graph: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/graph`).then((r) => json<Graph>(r)),
    mintToken: (name) =>
      fetch(`${base}/api/tokens`, POST({ name })).then((r) => json<{ token: string } & TokenInfo>(r)),
    listTokens: () => fetch(`${base}/api/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeToken: (id) => fetch(`${base}/api/tokens/${id}`, { method: 'DELETE' }).then(() => undefined),
    login: (email, password) =>
      fetch(`${base}/api/auth/login`, POST({ email, password })).then((r) => {
        if (!r.ok) {
          return r
            .json()
            .catch(() => ({}))
            .then((body: { error?: string }) => {
              throw new Error(body.error ?? `HTTP ${r.status}`);
            });
        }
        return r.json() as Promise<{ ok: true; user: { id: string; email: string } }>;
      }),
    logout: () =>
      fetch(`${base}/api/auth/logout`, { method: 'POST' }).then(() => undefined),
    listPasskeys: () =>
      fetch(`${base}/api/passkeys`).then((r) => json<PasskeyInfo[]>(r)),
    registerPasskey: async (label) => {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const optsRes = await fetch(`${base}/api/auth/passkey/register-options`, { method: 'POST' });
      if (!optsRes.ok) throw new Error(`register-options HTTP ${optsRes.status}`);
      const options = (await optsRes.json()) as Parameters<typeof startRegistration>[0]['optionsJSON'];
      const response = await startRegistration({ optionsJSON: options });
      const verifyRes = await fetch(`${base}/api/auth/passkey/register-verify`, POST({ response, label }));
      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `register-verify HTTP ${verifyRes.status}`);
      }
      return { ok: true } as const;
    },
    revokePasskey: (id) =>
      fetch(`${base}/api/passkeys/${id}`, { method: 'DELETE' }).then(() => undefined),
    signInWithPasskey: async () => {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const optsRes = await fetch(`${base}/api/auth/passkey/authenticate-options`, { method: 'POST' });
      if (!optsRes.ok) throw new Error(`authenticate-options HTTP ${optsRes.status}`);
      const options = (await optsRes.json()) as Parameters<typeof startAuthentication>[0]['optionsJSON'];
      const response = await startAuthentication({ optionsJSON: options });
      const verifyRes = await fetch(
        `${base}/api/auth/passkey/authenticate-verify`,
        POST({ response }),
      );
      if (!verifyRes.ok) {
        const body = (await verifyRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `authenticate-verify HTTP ${verifyRes.status}`);
      }
      return { ok: true } as const;
    },
    mintOrgToken: (orgId, name, scopes) =>
      fetch(`${base}/api/organizations/${orgId}/tokens`, POST({ name, scopes })).then((r) =>
        json<{ token: string } & TokenInfo>(r),
      ),
    listOrgTokens: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeOrgToken: (orgId, id) =>
      fetch(`${base}/api/organizations/${orgId}/tokens/${id}`, { method: 'DELETE' }).then(
        () => undefined,
      ),
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
    // ── Organizations ──────────────────────────────────────────────────
    listOrganizations: () =>
      fetch(`${base}/api/organizations`).then((r) => json<OrganizationWithRole[]>(r)),
    createOrganization: (name, slug) =>
      fetch(`${base}/api/organizations`, POST({ name, slug })).then((r) => json<Organization>(r)),
    renameOrganization: (id, name) =>
      fetch(`${base}/api/organizations/${id}`, { ...POST({ name }), method: 'PUT' }).then(() => undefined),
    deleteOrganization: (id) =>
      fetch(`${base}/api/organizations/${id}`, { method: 'DELETE' }).then(() => undefined),
    listOrgMembers: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/members`).then((r) => json<OrgMember[]>(r)),
    addOrgMember: (orgId, email, role) =>
      fetch(`${base}/api/organizations/${orgId}/members`, POST({ email, role })).then((r) =>
        json<{ ok: true; userId: string; role: OrgRole }>(r),
      ),
    updateOrgMember: (orgId, userId, role) =>
      fetch(`${base}/api/organizations/${orgId}/members/${userId}`, {
        ...POST({ role }),
        method: 'PUT',
      }).then(() => undefined),
    removeOrgMember: (orgId, userId) =>
      fetch(`${base}/api/organizations/${orgId}/members/${userId}`, { method: 'DELETE' }).then(
        () => undefined,
      ),
    listOrgWorkspaces: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/workspaces`).then((r) => json<Space[]>(r)),
    createWorkspace: (orgId, name) =>
      fetch(`${base}/api/spaces`, POST({ orgId, name })).then((r) => json<Space>(r)),
    renameWorkspace: (id, name) =>
      fetch(`${base}/api/spaces/${id}`, { ...POST({ name }), method: 'PUT' }).then(() => undefined),
    deleteWorkspace: (id) =>
      fetch(`${base}/api/spaces/${id}`, { method: 'DELETE' }).then(() => undefined),
    listWorkspaceMembers: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/members`).then((r) => json<WorkspaceMember[]>(r)),
    addWorkspaceMember: (spaceId, email, role) =>
      fetch(`${base}/api/spaces/${spaceId}/members`, POST({ email, role })).then((r) =>
        json<{ ok: true; userId: string; role: WorkspaceRole }>(r),
      ),
    updateWorkspaceMember: (spaceId, userId, role) =>
      fetch(`${base}/api/spaces/${spaceId}/members/${userId}`, {
        ...POST({ role }),
        method: 'PUT',
      }).then(() => undefined),
    removeWorkspaceMember: (spaceId, userId) =>
      fetch(`${base}/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' }).then(
        () => undefined,
      ),
  };
}
