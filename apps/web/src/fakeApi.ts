import type { ApiClient, Graph, Note, NoteRef, SearchResult, Space, TagCount, TokenInfo } from './api';

const tagsOf = (md: string): string[] => [
  ...new Set([...md.matchAll(/(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu)].map((m) => m[1].toLowerCase())),
];
const linksOf = (md: string): string[] => [
  ...new Set([...md.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim().toLowerCase())),
];

/** ApiClient en memoria para tests y demo offline. */
export function createFakeApi(opts?: { spaceId?: string }): ApiClient {
  const spaceId = opts?.spaceId ?? 'space-1';
  const spaces: Space[] = [{ id: spaceId, nombre: 'Mi espacio' }];
  const notes = new Map<string, Note>();
  let tokenList: TokenInfo[] = [];
  let seq = 0;

  const list = (sid: string) => [...notes.values()].filter((x) => x.espacioId === sid);

  return {
    async listSpaces() {
      return spaces;
    },
    async listNotes(sid) {
      return list(sid);
    },
    async notesByTag(sid, tag) {
      return list(sid).filter((n) => tagsOf(n.contenidoMd).includes(tag.toLowerCase()));
    },
    async createNote(sid, titulo, contenidoMd = '') {
      const note: Note = {
        id: `n${++seq}`,
        espacioId: sid,
        titulo,
        contenidoMd,
        creado: new Date().toISOString(),
        modificado: new Date().toISOString(),
      };
      notes.set(note.id, note);
      return { ...note };
    },
    async updateNote(id, patch) {
      const note = notes.get(id);
      if (!note) throw new Error('no existe');
      Object.assign(note, patch, { modificado: new Date().toISOString() });
      return { ...note };
    },
    async appendNote(id, contenido) {
      const note = notes.get(id);
      if (!note) throw new Error('no existe');
      note.contenidoMd = note.contenidoMd ? `${note.contenidoMd}\n${contenido}` : contenido;
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
    async listTags(sid) {
      const counts = new Map<string, number>();
      for (const n of list(sid)) for (const t of tagsOf(n.contenidoMd)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts.entries()]
        .map<TagCount>(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count);
    },
    async backlinks(noteId) {
      const target = notes.get(noteId)?.titulo.toLowerCase();
      if (!target) return [];
      return [...notes.values()]
        .filter((n) => linksOf(n.contenidoMd).includes(target))
        .map<NoteRef>((n) => ({ id: n.id, titulo: n.titulo }));
    },
    async graph(sid) {
      const ns = list(sid);
      const byTitulo = new Map(ns.map((n) => [n.titulo.toLowerCase(), n.id]));
      const edges: Graph['edges'] = [];
      for (const n of ns)
        for (const t of linksOf(n.contenidoMd)) {
          const tgt = byTitulo.get(t);
          if (tgt) edges.push({ source: n.id, target: tgt });
        }
      return { nodes: ns.map((n) => ({ id: n.id, titulo: n.titulo })), edges };
    },
    async mintToken(nombre) {
      const info: TokenInfo = { id: `t${++seq}`, nombre, creado: new Date().toISOString() };
      tokenList.push(info);
      return { ...info, token: `tok_${info.id}` };
    },
    async listTokens() {
      return tokenList;
    },
    async revokeToken(id) {
      tokenList = tokenList.filter((t) => t.id !== id);
    },
  };
}
