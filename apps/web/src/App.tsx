import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient, Carpeta, Note, TagCount } from './api';
import { useSettings } from './useSettings';
import { useRoute } from './router';
import { AppLayout } from './layout/AppLayout';
import { LeftDock } from './layout/LeftDock';
import { SettingsModal, type Tab as SettingsTab } from './layout/SettingsModal';
import { TopBar } from './layout/TopBar';
import { Editor } from './components/Editor';
import { GraphView } from './components/GraphView';
import { QuickSwitcher } from './components/QuickSwitcher';
import { TabsBar } from './components/TabsBar';
import { Button, EmptyState, StatusItem, useDialogs } from './ui';
import { useT } from './i18n';

const SETTINGS_TABS: SettingsTab[] = [
  'connect',
  'appearance',
  'search',
  'ai',
  'mcp',
  'space',
  'about',
];

export function App({ api }: { api: ApiClient }) {
  const dialogs = useDialogs();
  const t = useT();
  const { prefs, setPref } = useSettings();
  const [route, navigate] = useRoute();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [carpetas, setCarpetas] = useState<Carpeta[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // VS Code-style tabs: ordered list of open notes (by id, materialised from allNotes).
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  // Mobile sidebar drawer (md:hidden controls; desktop ignores).
  const [mobileDockOpen, setMobileDockOpen] = useState(false);

  // ── Derived state from URL ─────────────────────────────────────────────
  const current: Note | null = useMemo(
    () => (route.kind === 'note' ? allNotes.find((n) => n.id === route.id) ?? null : null),
    [route, allNotes],
  );
  const mainView: 'editor' | 'graph' = route.kind === 'graph' ? 'graph' : 'editor';
  const settingsOpen = route.kind === 'settings';
  const settingsTab: SettingsTab =
    route.kind === 'settings' && route.tab && (SETTINGS_TABS as string[]).includes(route.tab)
      ? (route.tab as SettingsTab)
      : 'connect';

  const openTabs: Note[] = useMemo(() => {
    const byId = new Map(allNotes.map((n) => [n.id, n] as const));
    return openTabIds.map((id) => byId.get(id)).filter((n): n is Note => Boolean(n));
  }, [openTabIds, allNotes]);

  // ── Initial load ───────────────────────────────────────────────────────
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

  // Auto-open route note as a tab. Append to end if new.
  useEffect(() => {
    if (route.kind !== 'note') return;
    setOpenTabIds((ids) => (ids.includes(route.id) ? ids : [...ids, route.id]));
  }, [route]);

  // Drop tabs that no longer correspond to existing notes (post-delete sync).
  useEffect(() => {
    const present = new Set(allNotes.map((n) => n.id));
    setOpenTabIds((ids) => {
      const next = ids.filter((id) => present.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [allNotes]);

  // Shortcuts: Ctrl/Cmd+K → quick switcher · Esc → close current note
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key === 'Escape' && current) {
        navigate({ kind: 'home' });
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [current, navigate]);

  // ── Multi-select ───────────────────────────────────────────────────────
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
    const ok = await dialogs.confirm('Delete notes?', {
      message: `${selected.size} note(s) will be permanently deleted.`,
      danger: true,
    });
    if (!ok) return;
    await api.deleteMany([...selected]);
    if (current && selected.has(current.id)) navigate({ kind: 'home' });
    clearSelected();
    if (spaceId) await refresh(spaceId);
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  function open(n: Note) {
    navigate({ kind: 'note', id: n.id });
    setMobileDockOpen(false);
  }
  function close() {
    navigate({ kind: 'home' });
  }

  /** Close a tab; if it was current, navigate to the previous tab (or home). */
  function closeTab(id: string) {
    setOpenTabIds((ids) => {
      const i = ids.indexOf(id);
      if (i === -1) return ids;
      const next = [...ids.slice(0, i), ...ids.slice(i + 1)];
      if (current?.id === id) {
        const fallback = next[i] ?? next[i - 1] ?? null;
        navigate(fallback ? { kind: 'note', id: fallback } : { kind: 'home' });
      }
      return next;
    });
  }

  async function createNote(folderId: string | null) {
    const title = await dialogs.prompt('New note', { placeholder: 'Title…', okLabel: 'Create' });
    if (!title || !spaceId) return;
    const n = await api.createNote(spaceId, title.trim(), `# ${title.trim()}\n\n`, folderId);
    await refresh(spaceId);
    open(n);
  }

  async function createFolder(parentId: string | null) {
    const name = await dialogs.prompt('New folder', {
      placeholder: 'Folder name…',
      okLabel: 'Create',
    });
    if (!name || !spaceId) return;
    await api.createCarpeta(spaceId, name.trim(), parentId);
    await refresh(spaceId);
  }

  async function renameFolder(id: string) {
    const c = carpetas.find((x) => x.id === id);
    const name = await dialogs.prompt('Rename folder', {
      defaultValue: c?.nombre,
      okLabel: 'Save',
    });
    if (!name) return;
    await api.renameCarpeta(id, name.trim());
    if (spaceId) await refresh(spaceId);
  }

  async function deleteFolder(id: string) {
    const ok = await dialogs.confirm('Delete folder?', {
      message: 'Notes inside will move to root. Subfolders are deleted.',
      danger: true,
    });
    if (!ok) return;
    await api.deleteCarpeta(id);
    if (spaceId) await refresh(spaceId);
  }

  async function onSaved(updated: Note) {
    setAllNotes((notes) => notes.map((n) => (n.id === updated.id ? updated : n)));
    if (spaceId) await refresh(spaceId);
  }

  async function onDeleted(n: Note) {
    await api.deleteNote(n.id);
    navigate({ kind: 'home' });
    if (spaceId) await refresh(spaceId);
  }

  async function onToggleFavorita(id: string, valor: boolean) {
    const upd = await api.setFavorita(id, valor);
    setAllNotes((notes) => notes.map((n) => (n.id === id ? upd : n)));
  }

  async function onFilterTag(tag: string) {
    if (!spaceId) return;
    const r = await api.notesByTag(spaceId, tag);
    if (r[0]) open(r[0]);
  }

  async function openByTitle(title: string) {
    const found = allNotes.find((n) => n.titulo === title);
    if (found) return open(found);
    if (!spaceId) return;
    const n = await api.createNote(spaceId, title, `# ${title}\n\n`);
    await refresh(spaceId);
    open(n);
  }

  function openById(id: string) {
    const n = allNotes.find((x) => x.id === id);
    if (n) open(n);
  }

  // ── Derived view data ──────────────────────────────────────────────────
  const recientes = [...allNotes]
    .sort((a, b) => (b.modificado ?? '').localeCompare(a.modificado ?? ''))
    .slice(0, 8);
  const favoritas = allNotes.filter((n) => n.favorita);

  const status = (
    <>
      <StatusItem
        onClick={() => navigate({ kind: 'settings', tab: 'mcp' })}
        title="MCP ready — click for connection details"
      >
        {t('status.mcp')}
      </StatusItem>
      <StatusItem
        onClick={() => navigate({ kind: 'settings', tab: 'space' })}
        title="Current workspace — click to manage"
      >
        {t('status.space')}
      </StatusItem>
      <span className="flex-1" />
      <StatusItem
        onClick={() => navigate({ kind: 'settings', tab: 'about' })}
        title={`Signed in as ${user?.email ?? 'admin local'} — click for account`}
      >
        👤 {user?.email ?? 'admin local'}
      </StatusItem>
    </>
  );

  return (
    <AppLayout
      sidebarWidth={prefs.sidebarWidth}
      onResizeSidebar={(w) => setPref('sidebarWidth', w)}
      mobileDockOpen={mobileDockOpen}
      onCloseMobileDock={() => setMobileDockOpen(false)}
      topBar={
        <TopBar
          onHome={() => navigate({ kind: 'home' })}
          onNew={() => createNote(null)}
          onQuick={() => setQuickOpen(true)}
          onGraph={() => navigate({ kind: 'graph' })}
          onSettings={() => navigate({ kind: 'settings' })}
          onToggleDock={() => setMobileDockOpen((v) => !v)}
        />
      }
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
          onFilterTag={onFilterTag}
        />
      }
      main={
        mainView === 'graph' ? (
          <GraphView api={api} spaceId={spaceId} onOpen={openById} />
        ) : (
          <>
            <TabsBar
              tabs={openTabs}
              currentId={current?.id ?? null}
              onSelect={openById}
              onClose={closeTab}
            />
            <div className="flex-1 min-h-0 flex flex-col">
              {current ? (
                <Editor
                  api={api}
                  note={current}
                  onSaved={onSaved}
                  onDeleted={onDeleted}
                  onOpenByTitle={openByTitle}
                  onToggleFavorita={onToggleFavorita}
                  onClose={close}
                />
              ) : (
                <EmptyState title={t('empty.title')} description={t('empty.desc')}>
                  <div className="flex gap-2">
                    <Button onClick={() => createNote(null)}>{t('empty.newNote')}</Button>
                    <Button
                      variant="secondary"
                      onClick={() => navigate({ kind: 'settings', tab: 'connect' })}
                    >
                      {t('empty.connect')}
                    </Button>
                  </div>
                </EmptyState>
              )}
            </div>
          </>
        )
      }
      status={status}
      modals={
        <>
          <SettingsModal
            open={settingsOpen}
            onClose={() => navigate({ kind: 'home' })}
            api={api}
            spaceId={spaceId}
            prefs={prefs}
            setPref={setPref}
            tab={settingsTab}
            onTabChange={(t) => navigate({ kind: 'settings', tab: t })}
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
