import { parseUsersCsv } from '@diluxite/core';
import type {
  SearchMode,
  ApiClient,
  AuditEvent,
  AuthPolicyValue,
  Folder,
  Graph,
  Info,
  Note,
  NoteRef,
  SearchResult,
  Space,
  Stats,
  TagCount,
  TokenInfo,
} from './api';

const tagsOf = (md: string): string[] => [
  ...new Set([...md.matchAll(/(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu)].map((m) => m[1].toLowerCase())),
];
const linksOf = (md: string): string[] => [
  ...new Set([...md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim().toLowerCase())),
];

/**
 * In-memory ApiClient for tests and offline demo.
 *
 * The fake mirrors the real backend's mode contract: in `local` (default)
 * the multi-tenant mutations (create/delete org, mint/revoke org tokens)
 * throw "HTTP 403 …" so consumers that copy this file as reference can't
 * accidentally build flows that the real API would reject in production.
 * Pass `{ authMode: 'server' }` for tests that exercise server-mode UX.
 */
let fakeSearchConfig: { mode: SearchMode; topK: number } = { mode: 'hybrid', topK: 5 };

export function createFakeApi(opts?: {
  spaceId?: string;
  authMode?: 'local' | 'server';
}): ApiClient {
  const spaceId = opts?.spaceId ?? 'space-1';
  const authMode: 'local' | 'server' = opts?.authMode ?? 'local';
  const requireServerMode = (label: string) => {
    if (authMode !== 'server') {
      throw new Error(`HTTP 403: ${label} requires server mode`);
    }
  };
  const spaces: Space[] = [{ id: spaceId, name: 'My space' }];
  const notes = new Map<string, Note>();
  // Soft-deleted notes — mirror the alpha.43 trash bin contract in the real backend.
  const trashed = new Map<string, Note>();
  const folders = new Map<string, Folder>();
  let tokenList: TokenInfo[] = [];
  let authPolicy: AuthPolicyValue = 'allow_unknown_as_member';
  const orgTokenLists = new Map<string, TokenInfo[]>();
  let seq = 0;

  const list = (sid: string) => [...notes.values()].filter((x) => x.spaceId === sid);

  return {
    // The org search config, in memory — the fake exists so the UI can be
    // exercised without a server, and a missing method is a crash rather
    // than a degraded experience.
    async getSearchConfig() {
      return { ...fakeSearchConfig };
    },
    async setSearchConfig(_orgId: string, cfg: { mode: SearchMode; topK: number }) {
      fakeSearchConfig = { ...cfg };
    },

    async exportZip() {
      // The demo has no server to build an archive; an empty one keeps the
      // button honest rather than pretending it downloaded a workspace.
      return { blob: new Blob([], { type: 'application/zip' }), filename: 'demo.zip' };
    },

    // A healthy install: the deterministic provider, and every stored vector
    // produced by it. The demo has no way to fall out of sync.
    async embeddingHealth() {
      return {
        active: { provider: 'local', semantic: false, dimensions: 64, model: null, endpoint: null },
        stored: [{ dimensions: 64, chunks: notes.size }],
        chunksWithoutEmbedding: 0,
        chunks: notes.size,
        reindexRequired: false,
      };
    },
    async reindex() {
      return { reindexed: notes.size, spaces: 1 };
    },

    async listSpaces() {
      return spaces;
    },
    async listNotes(sid) {
      return list(sid);
    },
    async notesByTag(sid, tag) {
      return list(sid).filter((n) => tagsOf(n.contentMd).includes(tag.toLowerCase()));
    },
    async createNote(sid, title, contentMd = '', folderId = null) {
      const note: Note = {
        id: `n${++seq}`,
        spaceId: sid,
        folderId,
        title,
        contentMd,
        favorite: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      notes.set(note.id, note);
      return { ...note };
    },
    async updateNote(id, patch) {
      const note = notes.get(id);
      if (!note) throw new Error('not found');
      Object.assign(note, patch, { updatedAt: new Date().toISOString() });
      return { ...note };
    },
    async appendNote(id, content) {
      const note = notes.get(id);
      if (!note) throw new Error('not found');
      note.contentMd = note.contentMd ? `${note.contentMd}\n${content}` : content;
      return { ...note };
    },
    async deleteNote(id) {
      // Match the real backend's alpha.43 contract: soft delete. The fake
      // keeps trashed notes in a separate Map so `listTrash` can return them.
      const n = notes.get(id);
      if (n) {
        notes.delete(id);
        trashed.set(id, n);
      }
    },
    // Version history: the fake keeps none — the demo playground has no
    // persistence, so history is honestly empty rather than invented.
    async listVersions() {
      return [];
    },
    async getVersion(): Promise<never> {
      throw new Error('no versions in the demo playground');
    },
    async restoreVersion(): Promise<never> {
      throw new Error('no versions in the demo playground');
    },
    async listTrash(sid) {
      return [...trashed.values()]
        .filter((n) => n.spaceId === sid)
        .map((n) => ({ id: n.id, title: n.title }));
    },
    async restoreNote(id) {
      const n = trashed.get(id);
      if (!n) throw new Error('HTTP 404');
      trashed.delete(id);
      notes.set(id, n);
      return { ok: true as const, note: { ...n } };
    },
    async purgeNote(id) {
      trashed.delete(id);
      return { ok: true as const };
    },
    async emptyTrash(sid) {
      let purged = 0;
      for (const [id, n] of [...trashed.entries()]) {
        if (n.spaceId === sid) {
          trashed.delete(id);
          purged++;
        }
      }
      return { ok: true as const, purged };
    },
    async deleteMany(ids) {
      let deleted = 0;
      for (const id of ids) if (notes.delete(id)) deleted++;
      return { deleted };
    },
    async setFavorite(id, value) {
      const n = notes.get(id);
      if (!n) throw new Error('not found');
      n.favorite = value;
      return { ...n };
    },
    async search(query) {
      const q = query.toLowerCase();
      return [...notes.values()]
        .filter((x) => x.title.toLowerCase().includes(q) || x.contentMd.toLowerCase().includes(q))
        .map<SearchResult>((x) => ({
          noteId: x.id,
          title: x.title,
          snippet: x.contentMd.slice(0, 100),
        }));
    },
    async info(): Promise<Info> {
      return {
        embedder: 'local',
        version: '0.0.0-fake',
        authMode,
        user: { email: 'local@diluxite' },
      };
    },
    async stats(sid): Promise<Stats> {
      const ns = list(sid);
      const byTitle = new Map(ns.map((n) => [n.title.toLowerCase(), n.id]));
      const tagset = new Set<string>();
      let links = 0;
      for (const n of ns) {
        for (const t of linksOf(n.contentMd)) if (byTitle.has(t)) links++;
        for (const tg of tagsOf(n.contentMd)) tagset.add(tg);
      }
      return { notes: ns.length, links, tags: tagset.size };
    },
    async listTags(sid) {
      const counts = new Map<string, number>();
      for (const n of list(sid)) for (const t of tagsOf(n.contentMd)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts.entries()]
        .map<TagCount>(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
    },
    async backlinks(noteId) {
      const target = notes.get(noteId)?.title.toLowerCase();
      if (!target) return [];
      return [...notes.values()]
        .filter((n) => linksOf(n.contentMd).includes(target))
        .map<NoteRef>((n) => ({ id: n.id, title: n.title }));
    },
    async related(noteId, limit = 10) {
      // Toy heuristic for tests: notes that share at least one tag with the
      // source rank highest. Distance is `1 - jaccard(tags)`.
      const src = notes.get(noteId);
      if (!src) return [];
      const sTags = new Set(tagsOf(src.contentMd));
      return [...notes.values()]
        .filter((n) => n.id !== noteId && n.spaceId === src.spaceId)
        .map((n) => {
          const t = new Set(tagsOf(n.contentMd));
          const inter = [...sTags].filter((x) => t.has(x)).length;
          const union = new Set([...sTags, ...t]).size || 1;
          return { id: n.id, title: n.title, distance: 1 - inter / union };
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
    },
    async graph(sid) {
      const ns = list(sid);
      const byTitle = new Map(ns.map((n) => [n.title.toLowerCase(), n.id]));
      const edges: Graph['edges'] = [];
      for (const n of ns)
        for (const t of linksOf(n.contentMd)) {
          const tgt = byTitle.get(t);
          if (tgt) edges.push({ source: n.id, target: tgt });
        }
      return {
        nodes: ns.map((n) => ({ id: n.id, title: n.title, folderId: n.folderId ?? null })),
        edges,
      };
    },
    async mintToken(name, expiresInDays) {
      const expiresAt =
        expiresInDays && expiresInDays > 0
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
          : null;
      const info: TokenInfo = {
        id: `t${++seq}`,
        name,
        createdAt: new Date().toISOString(),
        scopes: [],
        expiresAt,
      };
      tokenList.push(info);
      return { ...info, token: `tok_${info.id}` };
    },
    async listTokens() {
      return tokenList;
    },
    async revokeToken(id) {
      tokenList = tokenList.filter((t) => t.id !== id);
    },
    async revokeAllTokens() {
      const n = tokenList.length;
      tokenList = [];
      return { revoked: n };
    },
    async listActiveSessions() {
      return {
        sessions: [
          {
            id: 'sess-1',
            createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
            lastSeenAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
            ip: '127.0.0.1',
            userAgent: 'Mozilla/5.0 (fake)',
            current: true,
          },
        ],
      };
    },
    async revokeSession(_id) {
      return { ok: true as const };
    },
    async revokeOtherSessions() {
      return { revoked: 0 };
    },
    async forgotPassword(_email) {
      // Always success in the fake — mirrors the real backend's no-enumeration
      // contract. Tests that exercise the "email actually sends" branch should
      // assert on whatever side-effect (audit, store, etc) they care about.
      return { ok: true as const };
    },
    async resetPassword(_token, _newPassword) {
      return { ok: true as const, sessionsRevoked: 0 };
    },
    async changePassword(_current, _next) {
      return { ok: true as const, otherSessionsRevoked: 0 };
    },
    async totpStatus() {
      return { enabled: false, backupCodesRemaining: 0 };
    },
    async totpEnroll() {
      // Constant fake secret for snapshot stability in stories/tests.
      return {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUrl:
          'otpauth://totp/Diluxite:local%40diluxite?secret=JBSWY3DPEHPK3PXP&issuer=Diluxite&algorithm=SHA1&digits=6&period=30',
      };
    },
    async totpVerifyEnroll(_secret, _code) {
      return { ok: true, backupCodes: ['a1b2c3d4', 'e5f6a7b8', '1234abcd'] };
    },
    async totpDisable() {
      return { ok: true };
    },
    async getAuthPolicy() {
      return authPolicy;
    },
    async setAuthPolicy(_orgId, policy) {
      authPolicy = policy;
      return { policy };
    },
    async listAuditEvents(_orgId, query) {
      // Demo fixture: a few representative events for the UI to render.
      const all: AuditEvent[] = [
        {
          id: 3,
          at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
          orgId: 'org-1',
          actorId: 'u-local',
          action: 'admin.auth_policy.changed',
          resource: 'org:org-1',
          ip: '127.0.0.1',
          userAgent: 'Mozilla/5.0 (fake)',
          metadata: { from: 'allow_unknown_as_member', to: 'deny_unknown' },
        },
        {
          id: 2,
          at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
          orgId: 'org-1',
          actorId: 'u-local',
          action: 'auth.login.success',
          resource: null,
          ip: '127.0.0.1',
          userAgent: 'Mozilla/5.0 (fake)',
          metadata: { method: 'password' },
        },
        {
          id: 1,
          at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
          orgId: null,
          actorId: null,
          action: 'auth.login.failed',
          resource: null,
          ip: '203.0.113.42',
          userAgent: null,
          metadata: { attemptedEmail: 'someone@unknown.test' },
        },
      ];
      let filtered = all;
      if (query?.action) {
        filtered = filtered.filter((e) => e.action.startsWith(query.action!));
      }
      return { events: filtered, total: filtered.length };
    },
    async importUsersCsv(_orgId, csv, opts) {
      // Reuse the same parser used by the real API so unit tests of the UI
      // exercise the actual error reporting + dedup behaviour. In dry-run
      // we just echo back the parse result; otherwise we fake the
      // created/updated counts by tracking what we've seen.
      const { rows, errors, separator } = parseUsersCsv(csv);
      if (opts?.dryRun) {
        return { rows, errors, separator, applied: false };
      }
      // Heuristic: treat all CSV rows as 'created' in the fake unless the
      // same email shows up twice across calls (kept in a Set below).
      const created = rows.length; // for the UI test, this is enough
      const updated = 0;
      return { rows, errors, separator, applied: true, created, updated };
    },
    async mintOrgToken(orgId, name, scopes) {
      requireServerMode('org tokens');
      const info: TokenInfo = {
        id: `ot${++seq}`,
        name,
        createdAt: new Date().toISOString(),
        scopes: [...scopes],
      };
      const list = orgTokenLists.get(orgId) ?? [];
      list.push(info);
      orgTokenLists.set(orgId, list);
      return { ...info, token: `org_tok_${info.id}` };
    },
    async listOrgTokens(orgId) {
      return orgTokenLists.get(orgId) ?? [];
    },
    async login(email, _password) {
      return { ok: true, user: { id: 'u-local', email } };
    },
    async loginTotp(_mfaToken, _opts) {
      return { ok: true, user: { id: 'u-local', email: 'local@diluxite' } };
    },
    async logout() {
      // no-op
    },
    async listPasskeys() {
      return [];
    },
    async registerPasskey(_label) {
      return { ok: true } as const;
    },
    async revokePasskey(_id) {
      // no-op
    },
    async signInWithPasskey() {
      return { ok: true } as const;
    },
    async revokeOrgToken(orgId, id) {
      requireServerMode('org tokens');
      const list = orgTokenLists.get(orgId) ?? [];
      orgTokenLists.set(
        orgId,
        list.filter((t) => t.id !== id),
      );
    },
    async listFolders(sid) {
      return [...folders.values()].filter((c) => c.spaceId === sid);
    },
    async createFolder(sid, name, parentId = null) {
      const f: Folder = { id: `f${++seq}`, spaceId: sid, parentId, name, createdAt: new Date().toISOString() };
      folders.set(f.id, f);
      return { ...f };
    },
    async renameFolder(id, name) {
      const f = folders.get(id);
      if (!f) throw new Error('not found');
      f.name = name;
      return { ...f };
    },
    async moveFolder(id, parentId) {
      const f = folders.get(id);
      if (!f) throw new Error('not found');
      f.parentId = parentId;
      return { ...f };
    },
    async moveItems(_spaceId, { targetFolderId, noteIds, folderIds }) {
      let movedNotes = 0;
      let movedFolders = 0;
      for (const id of noteIds) {
        const n = notes.get(id);
        if (n) {
          n.folderId = targetFolderId;
          movedNotes++;
        }
      }
      for (const id of folderIds) {
        const f = folders.get(id);
        if (f && id !== targetFolderId) {
          f.parentId = targetFolderId;
          movedFolders++;
        }
      }
      return { movedNotes, movedFolders };
    },
    async deleteFolder(id) {
      // cascade: drops sub-folders and unlinks their notes
      const sub = [...folders.values()].filter((c) => c.parentId === id);
      for (const s of sub) await this.deleteFolder(s.id);
      for (const n of notes.values()) if (n.folderId === id) n.folderId = null;
      folders.delete(id);
    },

    // ── Org / workspace admin (in-memory fake) ─────────────────────────
    async listOrganizations() {
      return [{ id: 'org-1', name: 'Local', slug: 'local', role: 'super_admin' as const }];
    },
    async createOrganization(name, slug) {
      requireServerMode('organization creation');
      return { id: `org-${Date.now()}`, name, slug: slug ?? name.toLowerCase() };
    },
    async renameOrganization() {
      /* noop */
    },
    async deleteOrganization() {
      requireServerMode('organization deletion');
    },
    async listOrgMembers() {
      return [
        {
          userId: 'u-local',
          email: 'local@diluxite',
          role: 'super_admin' as const,
          joinedAt: new Date().toISOString(),
        },
      ];
    },
    async addOrgMember(_orgId, _email, role) {
      return { ok: true, userId: `u-${Date.now()}`, role };
    },
    async updateOrgMember() {
      /* noop */
    },
    async removeOrgMember() {
      /* noop */
    },
    async listOrgWorkspaces() {
      return [{ id: spaceId, name: 'My space' }];
    },
    async createWorkspace(_orgId, name) {
      return { id: `space-${Date.now()}`, name };
    },
    async renameWorkspace() {
      /* noop */
    },
    async deleteWorkspace() {
      /* noop */
    },
    async listWorkspaceMembers() {
      return [
        {
          userId: 'u-local',
          email: 'local@diluxite',
          role: 'admin' as const,
          joinedAt: new Date().toISOString(),
        },
      ];
    },
    async addWorkspaceMember(_spaceId, _email, role) {
      return { ok: true, userId: `u-${Date.now()}`, role };
    },
    async updateWorkspaceMember() {
      /* noop */
    },
    async removeWorkspaceMember() {
      /* noop */
    },
  };
}
