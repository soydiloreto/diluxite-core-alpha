import type {
  ApiClient,
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

/** In-memory ApiClient for tests and offline demo. */
export function createFakeApi(opts?: { spaceId?: string }): ApiClient {
  const spaceId = opts?.spaceId ?? 'space-1';
  const spaces: Space[] = [{ id: spaceId, name: 'My space' }];
  const notes = new Map<string, Note>();
  const folders = new Map<string, Folder>();
  let tokenList: TokenInfo[] = [];
  const orgTokenLists = new Map<string, TokenInfo[]>();
  let seq = 0;

  const list = (sid: string) => [...notes.values()].filter((x) => x.spaceId === sid);

  return {
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
      notes.delete(id);
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
      return { embedder: 'local', version: '4.0.0-alpha.0', user: { email: 'local@diluxite' } };
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
    async mintToken(name) {
      const info: TokenInfo = { id: `t${++seq}`, name, createdAt: new Date().toISOString(), scopes: [] };
      tokenList.push(info);
      return { ...info, token: `tok_${info.id}` };
    },
    async listTokens() {
      return tokenList;
    },
    async revokeToken(id) {
      tokenList = tokenList.filter((t) => t.id !== id);
    },
    async mintOrgToken(orgId, name, scopes) {
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
      return { id: `org-${Date.now()}`, name, slug: slug ?? name.toLowerCase() };
    },
    async renameOrganization() {
      /* noop */
    },
    async deleteOrganization() {
      /* noop */
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
