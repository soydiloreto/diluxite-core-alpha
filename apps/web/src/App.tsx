import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, Note, TagCount } from './api';
import { Sidebar } from './components/Sidebar';
import { Editor } from './components/Editor';
import { GraphView } from './components/GraphView';
import { Settings } from './components/Settings';

type View = 'editor' | 'graph' | 'settings';

export function App({ api }: { api: ApiClient }) {
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [filtered, setFiltered] = useState<Note[] | null>(null);
  const [filterLabel, setFilterLabel] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [current, setCurrent] = useState<Note | null>(null);
  const [view, setView] = useState<View>('editor');

  const refresh = useCallback(
    async (sid: string) => {
      setAllNotes(await api.listNotes(sid));
      setTags(await api.listTags(sid));
    },
    [api],
  );

  useEffect(() => {
    void (async () => {
      const sp = await api.listSpaces();
      const sid = sp[0]?.id ?? null;
      setSpaceId(sid);
      if (sid) await refresh(sid);
    })();
  }, [api, refresh]);

  const ensureSpace = useCallback(async () => {
    if (spaceId) return spaceId;
    const sp = await api.listSpaces();
    const sid = sp[0]?.id ?? null;
    setSpaceId(sid);
    return sid;
  }, [api, spaceId]);

  function clearFilter() {
    setFiltered(null);
    setFilterLabel(null);
    setActiveTag(null);
  }

  function open(n: Note) {
    setCurrent(n);
    setView('editor');
  }

  const createNote = useCallback(
    async (titulo: string) => {
      const sid = await ensureSpace();
      if (!sid || !titulo.trim()) return;
      const n = await api.createNote(sid, titulo.trim(), `# ${titulo.trim()}\n\n`);
      await refresh(sid);
      clearFilter();
      open(n);
    },
    [api, ensureSpace, refresh],
  );

  async function onSaved(updated: Note) {
    setCurrent(updated);
    if (spaceId) await refresh(spaceId);
  }

  async function onDeleted(n: Note) {
    await api.deleteNote(n.id);
    if (current?.id === n.id) setCurrent(null);
    if (spaceId) await refresh(spaceId);
  }

  async function onSearch(q: string) {
    if (!q.trim()) return clearFilter();
    const results = await api.search(q.trim(), spaceId ?? undefined);
    const byId = new Map(allNotes.map((n) => [n.id, n]));
    setFiltered(results.map((r) => byId.get(r.noteId)).filter((n): n is Note => !!n));
    setFilterLabel(`Búsqueda: "${q.trim()}"`);
    setActiveTag(null);
    setView('editor');
  }

  async function onTag(tag: string) {
    if (!spaceId) return;
    setFiltered(await api.notesByTag(spaceId, tag));
    setFilterLabel(`#${tag}`);
    setActiveTag(tag);
    setView('editor');
  }

  async function openByTitle(titulo: string) {
    const found = allNotes.find((n) => n.titulo === titulo);
    if (found) open(found);
    else await createNote(titulo);
  }

  function openById(id: string) {
    const n = allNotes.find((x) => x.id === id);
    if (n) open(n);
  }

  return (
    <div className="layout">
      <Sidebar
        notes={filtered ?? allNotes}
        tags={tags}
        activeTag={activeTag}
        filterLabel={filterLabel}
        onOpen={open}
        onNew={createNote}
        onSearch={onSearch}
        onTag={onTag}
        onClearFilter={clearFilter}
      />
      <main className="main">
        <nav className="tabs">
          <button className={view === 'editor' ? 'active' : ''} onClick={() => setView('editor')}>
            Editor
          </button>
          <button className={view === 'graph' ? 'active' : ''} onClick={() => setView('graph')}>
            Grafo
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            Ajustes
          </button>
        </nav>

        {view === 'editor' &&
          (current ? (
            <Editor
              api={api}
              note={current}
              onSaved={onSaved}
              onDeleted={onDeleted}
              onOpenByTitle={openByTitle}
            />
          ) : (
            <p className="empty">Elegí o creá una nota.</p>
          ))}
        {view === 'graph' && <GraphView api={api} spaceId={spaceId} onOpen={openById} />}
        {view === 'settings' && <Settings api={api} />}
      </main>
    </div>
  );
}
