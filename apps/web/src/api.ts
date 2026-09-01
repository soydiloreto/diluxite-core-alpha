export interface Space {
  id: string;
  orgId?: string;
  name: string;
}

export type OrgRole = 'org_admin' | 'org_member';
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

/**
 * How a note is ageing, judged against its OWN measured cadence (ADR-002).
 * `usingPrior` says the cadence is a structural guess rather than evidence —
 * the UI has to keep those apart, because "this note usually changes monthly"
 * and "notes shaped like this usually do" are different claims.
 */
export interface Freshness {
  level: 'fresh' | 'aging' | 'stale';
  ageSeconds: number;
  expectedIntervalSeconds: number;
  usingPrior: boolean;
  intervalsElapsed: number;
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
  /** Absent when the deployment measures no cadence — not the same as fresh. */
  freshness?: Freshness;
}

/** A history entry — what the note used to say before some save. */
export interface NoteVersionMeta {
  id: string;
  noteId: string;
  spaceId: string;
  title: string;
  createdAt: string;
}

export interface NoteVersion extends NoteVersionMeta {
  contentMd: string;
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

/** What the server accepts for org_settings.auth_policy. */
export type AuthPolicyValue =
  | 'deny_unknown'
  | 'allow_unknown_as_member'
  | 'pre_provisioned_only';

/** Result shape of `importUsersCsv`. Matches what the server returns. */
export interface CsvImportRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  line: number;
}
export interface CsvImportError {
  line: number;
  message: string;
  raw: string;
}
export interface CsvImportResult {
  rows: CsvImportRow[];
  errors: CsvImportError[];
  separator: ',' | ';';
  applied: boolean;
  created?: number;
  updated?: number;
}

/** Audit event as returned by GET /api/admin/orgs/:orgId/audit. */
export interface AuditEvent {
  id: number;
  at: string;
  orgId: string | null;
  actorId: string | null;
  action: string;
  resource: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditQuery {
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  beforeId?: number;
  limit?: number;
}

export interface TokenInfo {
  id: string;
  name: string;
  createdAt?: string;
  /** Empty for legacy user tokens; non-empty for org tokens. */
  scopes?: string[];
  /** ISO timestamp when the token expires. null/undefined = no TTL. */
  expiresAt?: string | null;
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
  /**
   * Where the browser should connect for collaborative editing. Three states:
   *   - absolute (`wss://collab.example.com`): use verbatim.
   *   - relative (`/collab`): resolve against window.location (same-origin).
   *   - null/missing: collab is disabled for this instance, editor stays
   *     in single-user mode.
   */
  collabUrl?: string | null;
  /** True when DILUXITE_OIDC_ISSUER + CLIENT_ID + SECRET + REDIRECT_URI están seteados
   *  Y el discovery del IdP funcionó al boot. Drives the "Sign in with SSO" button. */
  oidcEnabled?: boolean;
}
/**
 * Health of the semantic half of search — `GET /api/admin/embeddings`.
 *
 * `stored` is grouped by dimension because a corpus half-way through a
 * reindex holds two of them at once, and that is the state that breaks
 * semantic search.
 */
export interface EmbeddingHealth {
  active: {
    provider: string;
    /** False for the deterministic fallback: stable vectors, no meaning. */
    semantic: boolean;
    dimensions: number;
    model: string | null;
    endpoint: string | null;
  } | null;
  stored: {
    /** `"<provider>:<model>@<dims>"` — the vector space's identity. */
    key: string;
    dimensions: number;
    chunks: number;
    /** `active` answers queries; `building` is being filled and not live yet. */
    state: 'active' | 'building' | 'retired';
  }[];
  chunksWithoutEmbedding: number;
  chunks: number;
  reindexRequired: boolean;
}

export type EmbeddingProviderName = 'local' | 'ollama' | 'azure' | 'bedrock';

/** The stored provider choice. The credential is never in here — only whether one exists. */
export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  model: string | null;
  dimensions: number;
  endpoint: string | null;
  hasApiKey: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface EmbeddingConfigInput {
  provider: EmbeddingProviderName;
  model: string | null;
  dimensions: number;
  endpoint: string | null;
  /** Omit to keep the stored credential; `''` to remove it. */
  apiKey?: string | null;
}

export interface EmbeddingTestResult {
  ok: boolean;
  dimensions: number;
  expected: number;
  elapsedMs: number;
  error: string | null;
}

export interface Stats {
  notes: number;
  links: number;
  tags: number;
}

/** What an import did, or would do when asked for a dry run. */
export interface ImportResult {
  applied: boolean;
  format: 'obsidian' | 'notion' | 'markdown';
  created?: number;
  notes?: { title: string; folderPath: string[] }[];
  skipped: { path: string; reason: string }[];
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
  /**
   * Add or remove a tag across a selection.
   *
   * Tags live in the markdown — the server edits each note rather than writing
   * rows behind the text, which the next save would recompute away.
   */
  tagMany(
    ids: string[],
    ops: { add?: string[]; remove?: string[] },
  ): Promise<{ updated: number; unchanged: number; refused: number }>;
  /** Version history — snapshots of what the note used to say, newest first. */
  listVersions(noteId: string): Promise<NoteVersionMeta[]>;
  /** One full version, content included. */
  getVersion(noteId: string, versionId: string): Promise<NoteVersion>;
  /** Restore = a new save with that version's content (history is kept). */
  restoreVersion(noteId: string, versionId: string): Promise<Note>;
  /** Trash — list soft-deleted notes for a workspace. */
  listTrash(spaceId: string): Promise<NoteRef[]>;
  /** Restore a trashed note. Returns the freshly active note. */
  restoreNote(id: string): Promise<{ ok: true; note: Note }>;
  /** Hard-delete a trashed note (must be in trash). */
  purgeNote(id: string): Promise<{ ok: true }>;
  /** Empty the trash for a workspace. */
  emptyTrash(spaceId: string): Promise<{ ok: true; purged: number }>;
  setFavorite(id: string, value: boolean): Promise<Note>;
  listFolders(spaceId: string): Promise<Folder[]>;
  createFolder(spaceId: string, name: string, parentId?: string | null): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  moveFolder(id: string, parentId: string | null): Promise<Folder>;
  /** Atomic multi-select move: notes + folders → one destination (or root). */
  moveItems(
    spaceId: string,
    input: { targetFolderId: string | null; noteIds: string[]; folderIds: string[] },
  ): Promise<{ movedNotes: number; movedFolders: number }>;
  deleteFolder(id: string): Promise<void>;
  search(query: string, spaceId?: string, mode?: SearchMode, topK?: number): Promise<SearchResult[]>;
  /** The org's search configuration — the default everyone in it searches under. */
  getSearchConfig(orgId: string): Promise<{ mode: SearchMode; topK: number }>;
  setSearchConfig(orgId: string, cfg: { mode: SearchMode; topK: number }): Promise<void>;
  info(): Promise<Info>;
  /**
   * The workspace as a ZIP of Markdown files, with the filename the server
   * chose. Markdown rather than JSON: the point of an export is that another
   * tool can read it.
   */
  exportZip(spaceId: string): Promise<{ blob: Blob; filename: string }>;
  /**
   * A ZIP of Markdown back into notes — the mirror of `exportZip`.
   *
   * `dryRun` returns the plan without writing: an import is the one operation
   * where finding out afterwards is expensive.
   */
  importZip(
    spaceId: string,
    zipBase64: string,
    opts?: { dryRun?: boolean },
  ): Promise<ImportResult>;
  /** Which embedder is running, and whether the stored vectors match it. */
  embeddingHealth(orgId?: string): Promise<EmbeddingHealth>;
  /** The stored provider choice, and whether a credential could be stored at all. */
  getEmbeddingConfig(orgId: string): Promise<{ config: EmbeddingConfig | null; canStoreCredentials: boolean }>;
  /**
   * Save the choice. Does NOT switch the live model: the new vector space is
   * registered empty, and a reindex fills it before anything flips.
   */
  setEmbeddingConfig(
    orgId: string,
    input: EmbeddingConfigInput,
  ): Promise<{ config: EmbeddingConfig; model: { key: string; state: string }; nextStep: string }>;
  /** Ask the provider for one vector before trusting it with the corpus. */
  testEmbeddingProvider(orgId: string, input: EmbeddingConfigInput): Promise<EmbeddingTestResult>;
  /** Re-embed every note in scope. Synchronous — it returns when it is done. */
  reindex(scope?: {
    orgId?: string;
    spaceId?: string;
    /** Make the space that was just filled live, if it all went through. */
    activateWhenDone?: boolean;
  }): Promise<{ reindexed: number; spaces: number; activated: string | null }>;
  /**
   * The flip: make the space that was built the one queries are answered from.
   *
   * Refuses a space that is missing vectors unless `force` — a flip to an
   * unfilled space is a search that quietly stops finding things.
   */
  activateEmbeddingSpace(
    orgId: string,
    opts?: { slot?: string; force?: boolean },
  ): Promise<{ activated: string; previous: string | null; dropped: string[] }>;
  stats(spaceId: string): Promise<Stats>;
  listTags(spaceId: string): Promise<TagCount[]>;
  backlinks(noteId: string): Promise<NoteRef[]>;
  /** Notes semantically close to this one (pgvector cosine). */
  related(noteId: string, limit?: number): Promise<(NoteRef & { distance: number })[]>;
  graph(spaceId: string): Promise<Graph>;
  /**
   * Mint a personal API token. `expiresInDays` opcional — null o ausente =
   * sin expiración (legacy behaviour preservado). El servidor solo respeta
   * valores positivos.
   */
  mintToken(name: string, expiresInDays?: number | null): Promise<{ token: string } & TokenInfo>;
  listTokens(): Promise<TokenInfo[]>;
  revokeToken(id: string): Promise<void>;
  /** Panic button — revokes all of the user's tokens. Returns the count. */
  revokeAllTokens(): Promise<{ revoked: number }>;
  /**
   * Bulk import users from a CSV. When `dryRun: true`, only parses + reports
   * what WOULD happen — no DB writes. When false, applies (upserts by email).
   * Only org admins/org_admins can call this; others get 403.
   */
  importUsersCsv(
    orgId: string,
    csv: string,
    opts?: { dryRun?: boolean },
  ): Promise<CsvImportResult>;
  /** Read the org's auth_policy. Returns null when OIDC isn't configured (404). */
  getAuthPolicy(orgId: string): Promise<AuthPolicyValue | null>;
  /** Persist a new auth_policy for the org. Caller must be admin/org_admin. */
  setAuthPolicy(orgId: string, policy: AuthPolicyValue): Promise<{ policy: AuthPolicyValue }>;
  /** List audit events for an org. Members see their own; admins see everything. */
  listAuditEvents(
    orgId: string,
    query?: AuditQuery,
  ): Promise<{ events: AuditEvent[]; total: number }>;
  // Active sessions — server mode only. List + revoke endpoints behind cookie auth.
  listActiveSessions(): Promise<{
    sessions: Array<{
      id: string;
      createdAt: string;
      lastSeenAt: string | null;
      expiresAt: string;
      ip: string | null;
      userAgent: string | null;
      current: boolean;
    }>;
  }>;
  revokeSession(id: string): Promise<{ ok: true }>;
  revokeOtherSessions(): Promise<{ revoked: number }>;
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; otherSessionsRevoked: number }>;
  /**
   * Forgot password — server-mode only. Always returns ok:true regardless of
   * whether the email exists (no enumeration leak). The user receives an email
   * with a reset link iff their email is registered.
   */
  forgotPassword(email: string): Promise<{ ok: true }>;
  /**
   * Reset password — exchanges a valid token (from the email link) for a new
   * password. Revokes ALL sessions of the user; they have to sign in again.
   */
  resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: true; sessionsRevoked: number }>;
  // TOTP — 2FA. Available only in server mode; local fakeApi returns enabled=false.
  totpStatus(): Promise<{ enabled: boolean; backupCodesRemaining: number }>;
  totpEnroll(): Promise<{ secret: string; otpauthUrl: string }>;
  totpVerifyEnroll(secret: string, code: string): Promise<{ ok: true; backupCodes: string[] }>;
  totpDisable(): Promise<{ ok: boolean }>;
  // Server-mode auth (no-op in local mode — returns ok=true unconditionally
  // because the SingleUserAuthProvider has no login concept).
  login(
    email: string,
    password: string,
  ): Promise<
    | { ok: true; user: { id: string; email: string } }
    | { requiresMfa: true; mfaToken: string }
  >;
  loginTotp(
    mfaToken: string,
    opts: { code?: string; backupCode?: string },
  ): Promise<{ ok: true; user: { id: string; email: string } }>;
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

/**
 * Read the CSRF token the server set in the sibling `diluxite_csrf` cookie
 * (NOT HttpOnly so this is allowed). Returns `null` in local mode where the
 * cookie is never set. Called for every state-changing request — it's cheap.
 */
function readCsrfFromCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)diluxite_csrf=([^;]+)/);
  return m ? m[1] : null;
}

function withCsrf(_method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const tok = readCsrfFromCookie();
  if (tok) headers['x-csrf-token'] = tok;
  return headers;
}

const POST = (body: unknown) => ({
  method: 'POST',
  headers: withCsrf('POST'),
  body: JSON.stringify(body),
});

/** DELETE with the CSRF header attached so the server gate doesn't reject us. */
const DEL = (): RequestInit => ({ method: 'DELETE', headers: csrfHeaders() });

/**
 * For PUT/DELETE/PATCH callers that build their own RequestInit. Merge the
 * CSRF header into the existing headers without clobbering content-type.
 */
export function csrfHeaders(): Record<string, string> {
  const tok = readCsrfFromCookie();
  return tok ? { 'x-csrf-token': tok } : {};
}

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
    deleteNote: (id) => fetch(`${base}/api/notes/${id}`, DEL()).then(() => undefined),
    listVersions: (noteId) =>
      fetch(`${base}/api/notes/${noteId}/versions`).then((r) => json<NoteVersionMeta[]>(r)),
    getVersion: (noteId, versionId) =>
      fetch(`${base}/api/notes/${noteId}/versions/${versionId}`).then((r) => json<NoteVersion>(r)),
    restoreVersion: (noteId, versionId) =>
      fetch(`${base}/api/notes/${noteId}/versions/${versionId}/restore`, {
        method: 'POST',
        headers: withCsrf('POST'),
      }).then((r) => json<Note>(r)),
    listTrash: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/trash`).then((r) => json<NoteRef[]>(r)),
    restoreNote: (id) =>
      fetch(`${base}/api/notes/${id}/restore`, {
        method: 'POST',
        headers: withCsrf('POST'),
      }).then((r) => json<{ ok: true; note: Note }>(r)),
    purgeNote: (id) =>
      fetch(`${base}/api/notes/${id}/purge`, DEL()).then((r) =>
        json<{ ok: true }>(r),
      ),
    emptyTrash: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/trash`, DEL()).then((r) =>
        json<{ ok: true; purged: number }>(r),
      ),
    search: (query, spaceId, mode, topK) =>
      fetch(`${base}/api/search`, POST({ query, spaceId, mode, topK })).then((r) =>
        json<SearchResult[]>(r),
      ),
    getSearchConfig: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/search-config`).then((r) =>
        json<{ mode: SearchMode; topK: number }>(r),
      ),
    setSearchConfig: (orgId, cfg) =>
      fetch(`${base}/api/organizations/${orgId}/search-config`, {
        ...POST(cfg),
        method: 'PUT',
      }).then((r) =>
        json<void>(r),
      ),
    info: () => fetch(`${base}/api/info`).then((r) => json<Info>(r)),
    importZip: (spaceId, zipBase64, opts) =>
      fetch(`${base}/api/spaces/${spaceId}/import`, POST({ zipBase64, ...opts })).then((r) =>
        json<ImportResult>(r),
      ),
    exportZip: async (spaceId) => {
      const r = await fetch(`${base}/api/spaces/${spaceId}/export.zip`);
      if (!r.ok) throw new Error(`export failed: HTTP ${r.status}`);
      // `filename*` is the UTF-8 one and wins when both are present — an
      // accented workspace name arrives mangled if the ASCII fallback is read
      // instead.
      const cd = r.headers.get('content-disposition') ?? '';
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const plain = /filename="([^"]*)"/i.exec(cd);
      const filename = utf8
        ? decodeURIComponent(utf8[1])
        : (plain?.[1] ?? 'diluxite-export.zip');
      return { blob: await r.blob(), filename };
    },
    getEmbeddingConfig: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/embeddings/config`).then((r) =>
        json<{ config: EmbeddingConfig | null; canStoreCredentials: boolean }>(r),
      ),
    setEmbeddingConfig: (orgId, input) =>
      fetch(`${base}/api/organizations/${orgId}/embeddings/config`, {
        ...POST(input),
        method: 'PUT',
      }).then((r) =>
        json<{ config: EmbeddingConfig; model: { key: string; state: string }; nextStep: string }>(r),
      ),
    testEmbeddingProvider: (orgId, input) =>
      fetch(`${base}/api/organizations/${orgId}/embeddings/test`, POST(input)).then((r) =>
        json<EmbeddingTestResult>(r),
      ),
    embeddingHealth: (orgId) =>
      fetch(`${base}/api/admin/embeddings${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`).then(
        (r) => json<EmbeddingHealth>(r),
      ),
    reindex: (scope) =>
      fetch(`${base}/api/admin/reindex`, POST(scope ?? {})).then((r) =>
        json<{ reindexed: number; spaces: number; activated: string | null }>(r),
      ),
    activateEmbeddingSpace: (orgId, opts) =>
      fetch(`${base}/api/organizations/${orgId}/embeddings/activate`, POST(opts ?? {})).then((r) =>
        json<{ activated: string; previous: string | null; dropped: string[] }>(r),
      ),
    stats: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/stats`).then((r) => json<Stats>(r)),
    listTags: (spaceId) =>
      fetch(`${base}/api/spaces/${spaceId}/tags`).then((r) => json<TagCount[]>(r)),
    backlinks: (noteId) => fetch(`${base}/api/notes/${noteId}/backlinks`).then((r) => json<NoteRef[]>(r)),
    related: (noteId, limit = 10) =>
      fetch(`${base}/api/notes/${noteId}/related?limit=${limit}`).then((r) =>
        json<(NoteRef & { distance: number })[]>(r),
      ),
    graph: (spaceId) => fetch(`${base}/api/spaces/${spaceId}/graph`).then((r) => json<Graph>(r)),
    mintToken: (name, expiresInDays) =>
      fetch(`${base}/api/tokens`, POST({ name, expiresInDays })).then((r) =>
        json<{ token: string } & TokenInfo>(r),
      ),
    listTokens: () => fetch(`${base}/api/tokens`).then((r) => json<TokenInfo[]>(r)),
    revokeToken: (id) => fetch(`${base}/api/tokens/${id}`, DEL()).then(() => undefined),
    revokeAllTokens: () =>
      fetch(`${base}/api/tokens/revoke-all`, {
        method: 'POST',
        headers: withCsrf('POST'),
      }).then((r) =>
        json<{ revoked: number }>(r),
      ),
    importUsersCsv: (orgId, csv, opts) =>
      fetch(`${base}/api/admin/orgs/${orgId}/users/import-csv`, POST({ csv, dryRun: opts?.dryRun })).then(
        (r) => json<CsvImportResult>(r),
      ),
    getAuthPolicy: (orgId) =>
      fetch(`${base}/api/admin/orgs/${orgId}/auth-policy`).then(async (r) => {
        if (r.status === 404) return null;
        const body = (await r.json()) as { policy?: AuthPolicyValue };
        return body.policy ?? null;
      }),
    setAuthPolicy: (orgId, policy) =>
      fetch(`${base}/api/admin/orgs/${orgId}/auth-policy`, {
        method: 'PUT',
        headers: withCsrf('PUT'),
        body: JSON.stringify({ policy }),
      }).then((r) => json<{ policy: AuthPolicyValue }>(r)),
    listActiveSessions: () =>
      fetch(`${base}/api/auth/sessions`).then((r) =>
        json<{
          sessions: Array<{
            id: string;
            createdAt: string;
            lastSeenAt: string | null;
            expiresAt: string;
            ip: string | null;
            userAgent: string | null;
            current: boolean;
          }>;
        }>(r),
      ),
    revokeSession: (id) =>
      fetch(`${base}/api/auth/sessions/${id}`, DEL()).then((r) => json<{ ok: true }>(r)),
    revokeOtherSessions: () =>
      fetch(`${base}/api/auth/sessions/revoke-others`, {
        method: 'POST',
        headers: withCsrf('POST'),
      }).then((r) => json<{ revoked: number }>(r)),
    changePassword: (currentPassword, newPassword) =>
      fetch(`${base}/api/auth/password`, POST({ currentPassword, newPassword })).then((r) => {
        if (!r.ok) {
          return r
            .json()
            .catch(() => ({}))
            .then((body: { error?: string }) => {
              throw new Error(body.error ?? `HTTP ${r.status}`);
            });
        }
        return r.json() as Promise<{ ok: true; otherSessionsRevoked: number }>;
      }),
    forgotPassword: (email) =>
      fetch(`${base}/api/auth/forgot`, POST({ email })).then((r) => {
        // Server always returns 200 for valid requests (no leak); we only
        // surface real errors (rate-limit 429, 5xx) so the UI can retry.
        if (!r.ok) {
          return r
            .json()
            .catch(() => ({}))
            .then((body: { error?: string }) => {
              throw new Error(body.error ?? `HTTP ${r.status}`);
            });
        }
        return r.json() as Promise<{ ok: true }>;
      }),
    resetPassword: (token, newPassword) =>
      fetch(`${base}/api/auth/reset`, POST({ token, newPassword })).then((r) => {
        if (!r.ok) {
          return r
            .json()
            .catch(() => ({}))
            .then((body: { error?: string }) => {
              throw new Error(body.error ?? `HTTP ${r.status}`);
            });
        }
        return r.json() as Promise<{ ok: true; sessionsRevoked: number }>;
      }),
    totpStatus: () =>
      fetch(`${base}/api/auth/totp/status`).then((r) =>
        json<{ enabled: boolean; backupCodesRemaining: number }>(r),
      ),
    totpEnroll: () =>
      fetch(`${base}/api/auth/totp/enroll`, { method: 'POST', headers: withCsrf('POST') }).then(
        (r) => json<{ secret: string; otpauthUrl: string }>(r),
      ),
    totpVerifyEnroll: (secret, code) =>
      fetch(`${base}/api/auth/totp/verify-enroll`, {
        method: 'POST',
        headers: withCsrf('POST'),
        body: JSON.stringify({ secret, code }),
      }).then((r) => json<{ ok: true; backupCodes: string[] }>(r)),
    totpDisable: () => fetch(`${base}/api/auth/totp`, DEL()).then((r) => json<{ ok: boolean }>(r)),
    listAuditEvents: (orgId, query) => {
      const params = new URLSearchParams();
      if (query?.actorId) params.set('actorId', query.actorId);
      if (query?.action) params.set('action', query.action);
      if (query?.from) params.set('from', query.from);
      if (query?.to) params.set('to', query.to);
      if (query?.beforeId !== undefined) params.set('beforeId', String(query.beforeId));
      if (query?.limit !== undefined) params.set('limit', String(query.limit));
      const qs = params.toString() ? `?${params}` : '';
      return fetch(`${base}/api/admin/orgs/${orgId}/audit${qs}`).then((r) =>
        json<{ events: AuditEvent[]; total: number }>(r),
      );
    },
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
        return r.json() as Promise<
          | { ok: true; user: { id: string; email: string } }
          | { requiresMfa: true; mfaToken: string }
        >;
      }),
    loginTotp: (mfaToken, opts) =>
      fetch(`${base}/api/auth/login/totp`, POST({ mfaToken, ...opts })).then((r) => {
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
      fetch(`${base}/api/auth/logout`, { method: 'POST', headers: csrfHeaders() }).then(
        () => undefined,
      ),
    listPasskeys: () =>
      fetch(`${base}/api/passkeys`).then((r) => json<PasskeyInfo[]>(r)),
    registerPasskey: async (label) => {
      const { startRegistration } = await import('@simplewebauthn/browser');
      // Register runs with a session cookie, so the CSRF gate applies here
      // (unlike authenticate-options below, which is pre-auth).
      const optsRes = await fetch(`${base}/api/auth/passkey/register-options`, {
        method: 'POST',
        headers: withCsrf('POST'),
      });
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
      fetch(`${base}/api/passkeys/${id}`, DEL()).then(() => undefined),
    signInWithPasskey: async () => {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const optsRes = await fetch(`${base}/api/auth/passkey/authenticate-options`, {
        method: 'POST',
        headers: withCsrf('POST'),
      });
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
      fetch(`${base}/api/organizations/${orgId}/tokens/${id}`, DEL()).then(
        () => undefined,
      ),
    deleteMany: (ids) =>
      fetch(`${base}/api/notes/delete-many`, POST({ ids })).then((r) => json<{ deleted: number }>(r)),
    tagMany: (ids, ops) =>
      fetch(`${base}/api/notes/tag-many`, POST({ ids, ...ops })).then((r) =>
        json<{ updated: number; unchanged: number; refused: number }>(r),
      ),
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
    moveItems: (spaceId, input) =>
      fetch(`${base}/api/spaces/${spaceId}/move`, POST(input)).then((r) =>
        json<{ movedNotes: number; movedFolders: number }>(r),
      ),
    deleteFolder: (id) =>
      fetch(`${base}/api/folders/${id}`, DEL()).then(() => undefined),
    // ── Organizations ──────────────────────────────────────────────────
    listOrganizations: () =>
      fetch(`${base}/api/organizations`).then((r) => json<OrganizationWithRole[]>(r)),
    createOrganization: (name, slug) =>
      fetch(`${base}/api/organizations`, POST({ name, slug })).then((r) => json<Organization>(r)),
    renameOrganization: (id, name) =>
      fetch(`${base}/api/organizations/${id}`, { ...POST({ name }), method: 'PUT' }).then(() => undefined),
    deleteOrganization: (id) =>
      fetch(`${base}/api/organizations/${id}`, DEL()).then(() => undefined),
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
      fetch(`${base}/api/organizations/${orgId}/members/${userId}`, DEL()).then(
        () => undefined,
      ),
    listOrgWorkspaces: (orgId) =>
      fetch(`${base}/api/organizations/${orgId}/workspaces`).then((r) => json<Space[]>(r)),
    createWorkspace: (orgId, name) =>
      fetch(`${base}/api/spaces`, POST({ orgId, name })).then((r) => json<Space>(r)),
    renameWorkspace: (id, name) =>
      fetch(`${base}/api/spaces/${id}`, { ...POST({ name }), method: 'PUT' }).then(() => undefined),
    deleteWorkspace: (id) =>
      fetch(`${base}/api/spaces/${id}`, DEL()).then(() => undefined),
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
      fetch(`${base}/api/spaces/${spaceId}/members/${userId}`, DEL()).then(
        () => undefined,
      ),
  };
}
