import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, Carpeta, Note, TagCount } from './api';
import { useSettings } from './useSettings';
import { AppLayout } from './layout/AppLayout';
import { LeftDock } from './layout/LeftDock';
import { SettingsModal } from './layout/SettingsModal';
import { Editor } from './components/Editor';
import { GraphView } from './components/GraphView';
import { QuickSwitcher } from './components/QuickSwitcher';
import { Button, EmptyState, StatusItem } from './ui';

export function App({ api }: { api: ApiClient }) {
  const { prefs, setPref } = useSettings();
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [carpetas, setCarpetas] = useState<Carpeta[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);
  const [mainView, setMainView] = useState<'editor' | 'graph'>('editor');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggleSelected(id: string) {
    setSelected((s) => {
      const ns = new Set(s);
      ns.has(id) ? ns.delete(id) : ns.add(id);
      return ns;
    });
  }
  function clearSelected() {
    setSelected(new Set());
  }
  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`¿Borrar ${selected.size} nota(s)? Esta acción no se puede deshacer.`)) return;
    await api.deleteMany([...selected]);
    if (current && selected.has(current.id)) setCurrent(null);
    clearSelected();
    if (spaceId) await refresh(spaceId);
  }

  const refresh = useCallback(
    async (sid: string) => {
      const [n, t, c] = await Promise.all([
        api.listNotes(sid),
        api.listTags(sid),
        api.listCarpetas(sid),
      ]);
      setAllNotes(n);
      setTags(t);
      setCarpetas(c);
    },
    [api],
  );

  useEffect(() => {
    void (async () => {
      const spaces = await api.listSpaces();
      const sid = spaces[0]?.id ?? null;
      setSpaceId(sid);
      if (sid) await refresh(sid);
      void api.info().then((info) => setUser(info.user ?? null));
    })();
  }, [api, refresh]);

  // Atajo Ctrl/Cmd+K abre el buscador rápido
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  function open(n: Note) {
    setCurrent(n);
    setMainView('editor');
  }

  async function createNote(carpetaId: string | null) {
    const titulo = window.prompt('Título de la nota:');
    if (!titulo || !spaceId) return;
    const n = await api.createNote(spaceId, titulo.trim(), `# ${titulo.trim()}\n\n`, carpetaId);
    await refresh(spaceId);
    open(n);
  }

  async function createFolder(padreId: string | null) {
    const nombre = window.prompt('Nombre de la carpeta:');
    if (!nombre || !spaceId) return;
    await api.createCarpeta(spaceId, nombre.trim(), padreId);
    await refresh(spaceId);
  }

  async function renameFolder(id: string) {
    const nombre = window.prompt('Nuevo nombre:');
    if (!nombre) return;
    await api.renameCarpeta(id, nombre.trim());
    if (spaceId) await refresh(spaceId);
  }

  async function deleteFolder(id: string) {
    if (!window.confirm('¿Borrar esta carpeta? Las notas adentro suben a la raíz.')) return;
    await api.deleteCarpeta(id);
    if (spaceId) await refresh(spaceId);
  }

  async function onSaved(updated: Note) {
    setCurrent(updated);
    if (spaceId) await refresh(spaceId);
  }

  async function onDeleted(n: Note) {
    await api.deleteNote(n.id);
    if (current?.id === n.id) setCurrent(null);
    if (spaceId) await refresh(spaceId);
  }

  async function onToggleFavorita(id: string, valor: boolean) {
    const upd = await api.setFavorita(id, valor);
    setCurrent((c) => (c && c.id === id ? upd : c));
    if (spaceId) await refresh(spaceId);
  }

  async function onSearch(q: string) {
    if (!q.trim() || !spaceId) return;
    const results = await api.search(q.trim(), spaceId, prefs.searchMode, prefs.topK);
    if (results[0]) {
      const found = allNotes.find((n) => n.id === results[0].noteId);
      if (found) open(found);
    }
  }

  async function onFilterTag(tag: string) {
    if (!spaceId) return;
    const r = await api.notesByTag(spaceId, tag);
    if (r[0]) open(r[0]);
  }

  async function openByTitle(titulo: string) {
    const found = allNotes.find((n) => n.titulo === titulo);
    if (found) return open(found);
    if (!spaceId) return;
    const n = await api.createNote(spaceId, titulo, `# ${titulo}\n\n`);
    await refresh(spaceId);
    open(n);
  }

  function openById(id: string) {
    const n = allNotes.find((x) => x.id === id);
    if (n) open(n);
  }

  const recientes = [...allNotes]
    .sort((a, b) => (b.modificado ?? '').localeCompare(a.modificado ?? ''))
    .slice(0, 8);
  const favoritas = allNotes.filter((n) => n.favorita);

  const status = (
    <>
      <StatusItem onClick={() => setSettingsOpen(true)} title="Abrir Ajustes">
        ⚙ Ajustes
      </StatusItem>
      <StatusItem title="MCP listo">🟢 MCP</StatusItem>
      <StatusItem title={spaceId ?? ''}>📂 Mi espacio</StatusItem>
      <span className="flex-1" />
      <StatusItem title={user?.email ?? 'admin local'}>
        👤 {user?.email ?? 'admin local'}
      </StatusItem>
    </>
  );

  return (
    <AppLayout
      leftDock={
        <LeftDock
          notes={allNotes}
          carpetas={carpetas}
          tags={tags}
          recientes={recientes}
          favoritas={favoritas}
          currentNote={current}
          selected={selected}
          onToggleSelect={toggleSelected}
          onClearSelected={clearSelected}
          onDeleteSelected={deleteSelected}
          onOpen={open}
          onCreateNote={createNote}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onSearch={onSearch}
          onFilterTag={onFilterTag}
          onOpenQuickSwitcher={() => setQuickOpen(true)}
          onOpenGraph={() => setMainView('graph')}
        />
      }
      main={
        mainView === 'graph' ? (
          <GraphView api={api} spaceId={spaceId} onOpen={openById} />
        ) : current ? (
          <Editor
            api={api}
            note={current}
            onSaved={onSaved}
            onDeleted={onDeleted}
            onOpenByTitle={openByTitle}
            onToggleFavorita={onToggleFavorita}
          />
        ) : (
          <EmptyState
            title="Tu memoria está esperando"
            description="Creá tu primera nota desde el panel izquierdo, o conectá Claude por MCP (Ajustes → Conectar IA) para que la IA empiece a recordar y anotar por vos."
          >
            <div className="flex gap-2">
              <Button onClick={() => createNote(null)}>+ Nueva nota</Button>
              <Button variant="secondary" onClick={() => setSettingsOpen(true)}>
                Conectar IA
              </Button>
            </div>
          </EmptyState>
        )
      }
      status={status}
      modals={
        <>
          <SettingsModal
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            api={api}
            spaceId={spaceId}
            prefs={prefs}
            setPref={setPref}
          />
          <QuickSwitcher
            open={quickOpen}
            onClose={() => setQuickOpen(false)}
            notes={allNotes}
            onOpen={open}
          />
        </>
      }
    />
  );
}
