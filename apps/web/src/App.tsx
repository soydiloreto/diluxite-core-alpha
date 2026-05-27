import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { ApiClient, Carpeta, Note, TagCount } from './api';
import { useSettings } from './useSettings';
import { useRoute } from './router';
import { SettingsModal, type Tab as SettingsTab } from './layout/SettingsModal';
import { ActivityBar } from './shell/ActivityBar';
import { Sidebar } from './shell/Sidebar';
import { DockShell } from './shell/DockShell';
import { AppProvider, type AppCtx } from './shell/AppContext';
import { CommandPalette } from './components/CommandPalette';
import { StatusItem, StatusBar, useDialogs } from './ui';
import { useT } from './i18n';
import { Plug, Folder as FolderIcon } from './icons';

const SETTINGS_TABS: SettingsTab[] = ['connect', 'appearance', 'search', 'ai', 'mcp', 'space', 'about'];

/**
 * App shell, VS Code-style:
 *
 *   ┌──┬──────────┬──────────────────────────────┐
 *   │A │ Sidebar  │  Dockview (tabs + editor)    │
 *   │B │ (Expl.)  │                              │
 *   │  │          │                              │
 *   ├──┴──────────┴──────────────────────────────┤
 *   │ status bar                                 │
 *   └────────────────────────────────────────────┘
 *
 *   Activity bar holds brand, navigation icons, account popover, settings.
 *   Sidebar is collapsible (click Explorer in activity bar to hide / show).
 *   All heights collapse to viewport — nothing scrolls except panes that opt in.
 */
export function App({ api }: { api: ApiClient }) {
  const dialogs = useDialogs();
  const t = useT();
  const { prefs, setPref } = useSettings();
  const [route, navigate] = useRoute();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [carpetas, setCarpetas] = useState<Carpeta[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const dockRef = useRef<DockviewApi | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────
  const refresh = useCallback(
    async (sid: string) => {
      const [n, tg, c] = await Promise.all([
        api.listNotes(sid),
        api.listTags(sid),
        api.listCarpetas(sid),
      ]);
      setNotes(n);
      setTags(tg);
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

  // ── Dock helpers ───────────────────────────────────────────────────────
  const getNote = useCallback((id: string) => notes.find((n) => n.id === id), [notes]);

  const openNote = useCallback(
    (id: string) => {
      navigate({ kind: 'note', id });
      const dock = dockRef.current;
      const note = notes.find((n) => n.id === id);
      if (!dock || !note) return;
      const existing = dock.getPanel(`note:${id}`);
      if (existing) existing.api.setActive();
      else
        dock.addPanel({
          id: `note:${id}`,
          component: 'note',
          title: note.titulo,
          params: { noteId: id },
        });
    },
    [notes, navigate],
  );

  const openGraph = useCallback(() => {
    const dock = dockRef.current;
    navigate({ kind: 'graph' });
    if (!dock) return;
    const existing = dock.getPanel('graph');
    if (existing) existing.api.setActive();
    else dock.addPanel({ id: 'graph', component: 'graph', title: 'Graph' });
  }, [navigate]);

  const openSettings = useCallback(
    (tab?: string) => {
      const safe = tab && (SETTINGS_TABS as string[]).includes(tab) ? (tab as SettingsTab) : undefined;
      navigate(safe ? { kind: 'settings', tab: safe } : { kind: 'settings' });
    },
    [navigate],
  );

  // ── Mutations ──────────────────────────────────────────────────────────
  async function createNote(folderId: string | null) {
    const title = await dialogs.prompt('New note', { placeholder: 'Title…', okLabel: 'Create' });
    if (!title || !spaceId) return;
    const n = await api.createNote(spaceId, title.trim(), `# ${title.trim()}\n\n`, folderId);
    await refresh(spaceId);
    openNote(n.id);
  }

  async function createFolder(parentId: string | null) {
    const name = await dialogs.prompt('New folder', { placeholder: 'Folder name…', okLabel: 'Create' });
    if (!name || !spaceId) return;
    await api.createCarpeta(spaceId, name.trim(), parentId);
    await refresh(spaceId);
  }

  async function renameFolder(id: string) {
    const c = carpetas.find((x) => x.id === id);
    const name = await dialogs.prompt('Rename folder', { defaultValue: c?.nombre, okLabel: 'Save' });
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

  async function saveNote(id: string, content: string) {
    const upd = await api.updateNote(id, { contenidoMd: content });
    setNotes((ns) => ns.map((n) => (n.id === id ? upd : n)));
    if (spaceId) void api.listTags(spaceId).then(setTags);
  }

  const deleteNote = useCallback(
    async (id: string) => {
      const dock = dockRef.current;
      const panel = dock?.getPanel(`note:${id}`);
      if (panel) dock!.removePanel(panel);
      await api.deleteNote(id);
      if (spaceId) await refresh(spaceId);
    },
    [api, spaceId, refresh],
  );

  async function toggleFavorite(id: string, value: boolean) {
    const upd = await api.setFavorita(id, value);
    setNotes((ns) => ns.map((n) => (n.id === id ? upd : n)));
  }

  async function openByTitle(title: string) {
    const found = notes.find((n) => n.titulo === title);
    if (found) return openNote(found.id);
    if (!spaceId) return;
    const n = await api.createNote(spaceId, title, `# ${title}\n\n`);
    await refresh(spaceId);
    openNote(n.id);
  }

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
    const dock = dockRef.current;
    for (const id of selected) {
      const p = dock?.getPanel(`note:${id}`);
      if (p) dock!.removePanel(p);
    }
    await api.deleteMany([...selected]);
    clearSelected();
    if (spaceId) await refresh(spaceId);
  }

  // ── URL → Dock sync ────────────────────────────────────────────────────
  useEffect(() => {
    if (route.kind === 'note') openNote(route.id);
    else if (route.kind === 'graph') openGraph();
  }, [route, openNote, openGraph]);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    for (const n of notes) {
      const p = dock.getPanel(`note:${n.id}`);
      if (p) p.api.setTitle(n.titulo);
    }
  }, [notes]);

  // ── Shortcuts ──────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key === 'Escape' && quickOpen) {
        setQuickOpen(false);
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [quickOpen]);

  useEffect(() => {
    const h = () => void createNote(null);
    window.addEventListener('diluxite:new-note', h);
    return () => window.removeEventListener('diluxite:new-note', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  // ── Settings modal state ───────────────────────────────────────────────
  const settingsOpen = route.kind === 'settings';
  const settingsTab: SettingsTab =
    route.kind === 'settings' && route.tab && (SETTINGS_TABS as string[]).includes(route.tab)
      ? (route.tab as SettingsTab)
      : 'connect';

  const activeView: 'explorer' | 'graph' | 'settings' | null =
    route.kind === 'graph' ? 'graph' : route.kind === 'settings' ? 'settings' : 'explorer';

  const ctx: AppCtx = useMemo(
    () => ({
      api,
      spaceId,
      notes,
      carpetas,
      tags,
      prefs,
      setPref,
      getNote,
      openNote,
      openByTitle,
      openGraph,
      openSettings,
      saveNote,
      deleteNote,
      toggleFavorite,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, spaceId, notes, carpetas, tags, prefs, getNote, openNote, openGraph, openSettings, deleteNote],
  );

  return (
    <AppProvider value={ctx}>
      <div className="h-full flex flex-col bg-bg text-ink overflow-hidden">
        <div className="flex-1 min-h-0 flex relative">
          <ActivityBar
            active={activeView}
            user={user}
            workspaceLabel={spaceId ? `Workspace · ${spaceId.slice(0, 8)}…` : 'No workspace'}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onHome={() => navigate({ kind: 'home' })}
            onSearch={() => setQuickOpen(true)}
            onGraph={openGraph}
            onNew={() => createNote(null)}
            onSettings={() => openSettings()}
            onAccount={(tab) => openSettings(tab)}
          />

          {sidebarOpen && (
            <>
              <aside
                data-testid="left-dock"
                style={{ width: prefs.sidebarWidth }}
                className="shrink-0 h-full border-r border-line bg-bg-surface overflow-hidden"
              >
                <Sidebar
                  selected={selected}
                  onToggleSelect={toggleSelected}
                  onClearSelected={clearSelected}
                  onDeleteSelected={deleteSelected}
                  onCreateNote={createNote}
                  onCreateFolder={createFolder}
                  onRenameFolder={renameFolder}
                  onDeleteFolder={deleteFolder}
                />
              </aside>
              <ResizeHandle
                left={48 + prefs.sidebarWidth - 3 /* activity bar + sidebar */}
                onResize={(w) => setPref('sidebarWidth', Math.max(180, Math.min(560, w - 48)))}
              />
            </>
          )}

          <main className="flex-1 min-w-0 h-full relative" data-testid="main">
            <DockShell
              onReady={(dock) => {
                dockRef.current = dock;
                if (!dock.getPanel('welcome')) {
                  dock.addPanel({ id: 'welcome', component: 'welcome', title: 'Welcome' });
                }
                if (route.kind === 'note') openNote(route.id);
                else if (route.kind === 'graph') openGraph();
              }}
            />
          </main>
        </div>

        <StatusBar>
          <StatusItem onClick={() => openSettings('mcp')} title="MCP ready — click for connection details">
            <Plug size={12} className="text-emerald-400" /> {t('status.mcp').replace('🟢 ', '')}
          </StatusItem>
          <StatusItem onClick={() => openSettings('space')} title="Current workspace">
            <FolderIcon size={12} /> {t('status.space').replace('📂 ', '')}
          </StatusItem>
          <span className="flex-1" />
          <StatusItem title={`${notes.length} notes · ${tags.length} tags`}>
            {notes.length} notes
          </StatusItem>
        </StatusBar>

        <SettingsModal
          open={settingsOpen}
          onClose={() => navigate({ kind: 'home' })}
          api={api}
          spaceId={spaceId}
          prefs={prefs}
          setPref={setPref}
          tab={settingsTab}
          onTabChange={(tb) => navigate({ kind: 'settings', tab: tb })}
        />
        <CommandPalette
          open={quickOpen}
          onClose={() => setQuickOpen(false)}
          onNew={() => createNote(null)}
        />
      </div>
    </AppProvider>
  );
}

function ResizeHandle({ left, onResize }: { left: number; onResize: (w: number) => void }) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      onResize(e.clientX);
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onResize]);
  return (
    <div
      data-testid="sidebar-resize"
      role="separator"
      aria-label="resize sidebar"
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      className="absolute top-0 z-20 w-1.5 h-full cursor-col-resize hover:bg-brand/40 transition-colors"
      style={{ left }}
    />
  );
}
