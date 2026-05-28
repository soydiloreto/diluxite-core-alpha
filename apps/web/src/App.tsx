import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { ApiClient, Folder, Note, OrganizationWithRole, Space, TagCount } from './api';
import { useSettings } from './useSettings';
import { useRoute, type Route } from './router';
import { SettingsModal, type Tab as SettingsTab } from './layout/SettingsModal';
import { ActivityBar, type ActivityView } from './shell/ActivityBar';
import { Sidebar } from './shell/Sidebar';
import { DockShell } from './shell/DockShell';
import { AppProvider, type AppCtx } from './shell/AppContext';
import { TopBar, type TopBarHandle } from './shell/TopBar';
import { WorkspaceSelector } from './shell/WorkspaceSelector';
import { AdminConsole, type AdminSection } from './shell/admin/AdminConsole';
import { FavoritesView } from './shell/views/FavoritesView';
import { RecentView } from './shell/views/RecentView';
import { SearchView } from './shell/views/SearchView';
import { StatusItem, StatusBar, useDialogs } from './ui';
import { useT } from './i18n';
import { Plug, Folder as FolderIcon } from './icons';

const SETTINGS_TABS: SettingsTab[] = ['connect', 'appearance', 'search', 'ai', 'mcp', 'space', 'about'];

type SidebarView = 'explorer' | 'favorites' | 'recent' | 'search';

/**
 * App shell, VS Code-style.
 *
 *   ┌──┬──────────┬──────────────────────────────┐
 *   │A │ Sidebar  │  Dockview (tabs + editor)    │
 *   │B │ (view)   │                              │
 *   │  │          │                              │
 *   ├──┴──────────┴──────────────────────────────┤
 *   │ status bar                                 │
 *   └────────────────────────────────────────────┘
 *
 * The Activity bar (A) holds top-level navigation: Explorer (folders +
 * notes tree), Search, Graph, Favorites, Recent, Tags, Backlinks, +
 * New note, Account, Settings. Clicking a view button switches the
 * Sidebar's contents (B). The Dockview area to the right is where
 * notes / graph open as tabs.
 */
export function App({ api }: { api: ApiClient }) {
  const dialogs = useDialogs();
  const t = useT();
  const { prefs, setPref } = useSettings();
  const [route, navigate] = useRoute();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [allSpaces, setAllSpaces] = useState<Space[]>([]);
  const [orgs, setOrgs] = useState<OrganizationWithRole[]>([]);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const topBarRef = useRef<TopBarHandle>(null);
  // The view shown in the sidebar (Activity bar selection). 'explorer' is the
  // default Folders + notes tree; the others are the new top-level lists.
  const [sidebarView, setSidebarView] = useState<SidebarView>('explorer');
  // Last note the user navigated to. Persists across sidebar-view switches
  // (clicking Backlinks / Tags / Recent doesn't reset it) so the dependent
  // panels can keep showing the right note. Reset by deleteNote when it
  // matches the note being removed.
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);

  const dockRef = useRef<DockviewApi | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────
  const refresh = useCallback(
    async (sid: string) => {
      const [n, tg, f] = await Promise.all([
        api.listNotes(sid),
        api.listTags(sid),
        api.listFolders(sid),
      ]);
      setNotes(n);
      setTags(tg);
      setFolders(f);
    },
    [api],
  );

  useEffect(() => {
    void (async () => {
      const [spaces, orgList, info] = await Promise.all([
        api.listSpaces(),
        api.listOrganizations(),
        api.info(),
      ]);
      setAllSpaces(spaces);
      setOrgs(orgList);
      setUser(info.user ?? null);
      const sid = spaces[0]?.id ?? null;
      setSpaceId(sid);
      if (sid) await refresh(sid);
    })();
  }, [api, refresh]);

  // Switching workspaces re-fetches the dependent lists.
  const switchWorkspace = useCallback(
    async (sid: string) => {
      if (sid === spaceId) return;
      setSpaceId(sid);
      // Close any open note tabs from the previous workspace.
      const dock = dockRef.current;
      if (dock) {
        for (const id of [...notes.map((n) => `note:${n.id}`)]) {
          const p = dock.getPanel(id);
          if (p) dock.removePanel(p);
        }
      }
      setNotes([]);
      setFolders([]);
      setTags([]);
      await refresh(sid);
      navigate({ kind: 'home' });
    },
    [spaceId, notes, refresh, navigate],
  );

  const canSeeAdmin = useMemo(
    () => orgs.some((o) => o.role === 'super_admin' || o.role === 'admin' || o.role === 'member'),
    [orgs],
  );

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
          title: note.title,
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

  const openSidebarView = useCallback(
    (v: 'favorites' | 'recent' | 'search') => {
      setSidebarView(v);
      setSidebarOpen(true);
      navigate({ kind: v } as Route);
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
    await api.createFolder(spaceId, name.trim(), parentId);
    await refresh(spaceId);
  }

  async function renameFolder(id: string) {
    const f = folders.find((x) => x.id === id);
    const name = await dialogs.prompt('Rename folder', { defaultValue: f?.name, okLabel: 'Save' });
    if (!name) return;
    await api.renameFolder(id, name.trim());
    if (spaceId) await refresh(spaceId);
  }

  async function deleteFolder(id: string) {
    const ok = await dialogs.confirm('Delete folder?', {
      message:
        'Everything inside (notes and subfolders) will be permanently deleted. ' +
        'To keep a note, move it out first.',
      danger: true,
    });
    if (!ok) return;
    await api.deleteFolder(id);
    if (spaceId) await refresh(spaceId);
  }

  async function saveNote(id: string, content: string) {
    const upd = await api.updateNote(id, { contentMd: content });
    setNotes((ns) => ns.map((n) => (n.id === id ? upd : n)));
    if (spaceId) void api.listTags(spaceId).then(setTags);
  }

  const renameNote = useCallback(
    async (note: Note) => {
      const title = await dialogs.prompt('Rename note', {
        defaultValue: note.title,
        okLabel: 'Save',
      });
      if (!title || title.trim() === note.title) return;
      const upd = await api.updateNote(note.id, { title: title.trim() });
      setNotes((ns) => ns.map((n) => (n.id === note.id ? upd : n)));
    },
    [api, dialogs],
  );

  const deleteNote = useCallback(
    async (id: string) => {
      const dock = dockRef.current;
      const panel = dock?.getPanel(`note:${id}`);
      if (panel) dock!.removePanel(panel);
      await api.deleteNote(id);
      if (spaceId) await refresh(spaceId);
      setCurrentNoteId((prev) => (prev === id ? null : prev));
    },
    [api, spaceId, refresh],
  );

  /** Confirm + delete (the bare deleteNote skips confirmation). */
  const confirmDeleteNote = useCallback(
    async (note: Note) => {
      const ok = await dialogs.confirm('Delete note?', {
        message: `«${note.title}» will be permanently deleted.`,
        danger: true,
      });
      if (ok) await deleteNote(note.id);
    },
    [dialogs, deleteNote],
  );

  async function toggleFavorite(id: string, value: boolean) {
    const upd = await api.setFavorite(id, value);
    setNotes((ns) => ns.map((n) => (n.id === id ? upd : n)));
  }

  const moveNoteToFolder = useCallback(
    async (noteId: string, folderId: string | null) => {
      const upd = await api.updateNote(noteId, { folderId });
      setNotes((ns) => ns.map((n) => (n.id === noteId ? upd : n)));
    },
    [api],
  );

  const moveFolderToFolder = useCallback(
    async (folderId: string, parentId: string | null) => {
      try {
        await api.moveFolder(folderId, parentId);
        if (spaceId) await refresh(spaceId);
      } catch (e) {
        // The server rejects loops (folder dropped into a descendant) — surface
        // a friendly message instead of bubbling the raw HTTP error.
        await dialogs.confirm("Couldn't move folder", {
          message:
            'The destination is the folder itself or one of its descendants. Pick a different target.',
        });
      }
    },
    [api, spaceId, refresh, dialogs],
  );

  const toggleFavoriteByNote = useCallback(
    (note: Note) => {
      void toggleFavorite(note.id, !note.favorite);
    },
    [],
  );

  async function openByTitle(title: string) {
    const found = notes.find((n) => n.title === title);
    if (found) return openNote(found.id);
    if (!spaceId) return;
    const n = await api.createNote(spaceId, title, `# ${title}\n\n`);
    await refresh(spaceId);
    openNote(n.id);
  }

  // ── URL → Dock / Sidebar sync ──────────────────────────────────────────
  // The router owns the "deep" view state (note / graph / settings + the
  // sidebar-only views favorites / recent / tags / backlinks). Mirror it.
  useEffect(() => {
    if (route.kind === 'note') {
      setCurrentNoteId(route.id);
      openNote(route.id);
    } else if (route.kind === 'graph') openGraph();
    else if (route.kind === 'favorites' || route.kind === 'recent' || route.kind === 'search') {
      setSidebarView(route.kind);
      setSidebarOpen(true);
    }
  }, [route, openNote, openGraph]);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    for (const n of notes) {
      const p = dock.getPanel(`note:${n.id}`);
      if (p) p.api.setTitle(n.title);
    }
  }, [notes]);

  // Middle-click on a Dockview tab closes that tab — matches VS Code /
  // browser muscle memory. We listen on the dock container and resolve the
  // clicked tab to a panel by title (titles are unique per panel: notes
  // carry their own title, the welcome + graph panels have static names).
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 1) return;
      const dock = dockRef.current;
      if (!dock) return;
      const tab = (e.target as HTMLElement | null)?.closest('.dv-tab, [role="tab"]');
      if (!tab) return;
      const label = tab.textContent?.trim();
      if (!label) return;
      const panel = dock.panels.find((p) => p.title === label);
      if (!panel) return;
      e.preventDefault();
      dock.removePanel(panel);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  // Close any note tab whose backing note no longer exists. This catches:
  //  - individual deletes (covered already by deleteNote, kept idempotent),
  //  - folder cascade deletes (the parent dropped many notes at once),
  //  - bulk deletes, and
  //  - external mutations (someone else hit the API).
  // Running it as a `notes` effect keeps the rule in one place.
  useEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const alive = new Set(notes.map((n) => n.id));
    for (const panel of dock.panels) {
      if (!panel.id.startsWith('note:')) continue;
      const id = panel.id.slice('note:'.length);
      if (!alive.has(id)) dock.removePanel(panel);
    }
  }, [notes]);

  // ── Shortcuts ──────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        topBarRef.current?.focusSearch();
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  useEffect(() => {
    const h = () => void createNote(null);
    window.addEventListener('diluxite:new-note', h);
    return () => window.removeEventListener('diluxite:new-note', h);
  }, [spaceId]);

  // ── Settings modal state ───────────────────────────────────────────────
  const settingsOpen = route.kind === 'settings';
  const settingsTab: SettingsTab =
    route.kind === 'settings' && route.tab && (SETTINGS_TABS as string[]).includes(route.tab)
      ? (route.tab as SettingsTab)
      : 'connect';

  const activeView: ActivityView | null =
    route.kind === 'graph'
      ? 'graph'
      : route.kind === 'settings'
        ? 'settings'
        : route.kind === 'admin'
          ? 'admin'
          : route.kind === 'favorites' || route.kind === 'recent' || route.kind === 'search'
            ? route.kind
            : 'explorer';

  const searchTag = useCallback((tag: string) => {
    topBarRef.current?.focusSearch(`#${tag}`);
  }, []);

  // Re-fetch everything (notes/folders/tags) — used after bulk operations
  // that bypass saveNote (Search & Replace All, future scripts, etc.).
  const refreshAll = useCallback(async () => {
    if (spaceId) await refresh(spaceId);
  }, [spaceId, refresh]);

  const ctx: AppCtx = useMemo(
    () => ({
      api,
      spaceId,
      notes,
      folders,
      tags,
      currentNoteId,
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
      searchTag,
      refreshAll,
    }),
    [api, spaceId, notes, folders, tags, currentNoteId, prefs, getNote, openNote, openGraph, openSettings, deleteNote, searchTag, refreshAll],
  );

  // Pick the body component for the sidebar.
  const sidebarBody = (() => {
    switch (sidebarView) {
      case 'favorites':
        return <FavoritesView />;
      case 'recent':
        return <RecentView />;
      case 'search':
        return <SearchView />;
      case 'explorer':
      default:
        return (
          <Sidebar
            onCreateNote={createNote}
            onCreateFolder={createFolder}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            onDeleteNote={confirmDeleteNote}
            onRenameNote={renameNote}
            onToggleFavorite={toggleFavoriteByNote}
            onMoveNoteToFolder={moveNoteToFolder}
            onMoveFolderToFolder={moveFolderToFolder}
          />
        );
    }
  })();

  // Take ownership of right-click app-wide so the browser's menu never
  // bleeds through. Native menus are still allowed where the user expects
  // them: text inputs, the Monaco editor (which renders its own), and
  // anywhere with contenteditable.
  function suppressNativeContextMenu(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"], .monaco-editor')) return;
    e.preventDefault();
  }

  return (
    <AppProvider value={ctx}>
      <div
        className="h-full flex flex-col bg-bg text-ink overflow-hidden"
        onContextMenu={suppressNativeContextMenu}
      >
        <TopBar
          ref={topBarRef}
          onNewNote={() => createNote(null)}
          workspaceSelector={
            allSpaces.length > 0 ? (
              <WorkspaceSelector
                workspaces={allSpaces}
                activeId={spaceId}
                onPick={(id) => void switchWorkspace(id)}
                onManage={() => navigate({ kind: 'admin', section: 'workspaces' })}
              />
            ) : null
          }
        />
        <div className="flex-1 min-h-0 flex relative">
          <ActivityBar
            active={activeView}
            user={user}
            workspaceLabel={
              allSpaces.find((s) => s.id === spaceId)?.name ?? 'No workspace'
            }
            sidebarOpen={sidebarOpen}
            showAdmin={canSeeAdmin}
            onToggleSidebar={() => {
              if (sidebarOpen && sidebarView === 'explorer') setSidebarOpen(false);
              else {
                setSidebarView('explorer');
                setSidebarOpen(true);
                navigate({ kind: 'home' });
              }
            }}
            onHome={() => {
              setSidebarView('explorer');
              navigate({ kind: 'home' });
            }}
            onGraph={openGraph}
            onView={openSidebarView}
            onNew={() => createNote(null)}
            onAdmin={() => navigate({ kind: 'admin' })}
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
                {sidebarBody}
              </aside>
              <ResizeHandle
                left={48 + prefs.sidebarWidth - 3 /* activity bar + sidebar */}
                onResize={(w) => setPref('sidebarWidth', Math.max(180, Math.min(560, w - 48)))}
              />
            </>
          )}

          <main className="flex-1 min-w-0 h-full relative" data-testid="main">
            {route.kind === 'admin' ? (
              <AdminConsole
                section={
                  (route.section as AdminSection | undefined) ?? 'organization'
                }
                onSection={(s) => navigate({ kind: 'admin', section: s })}
              />
            ) : (
              <DockShell
                onReady={(dock) => {
                  dockRef.current = dock;
                  if (!dock.getPanel('welcome')) {
                    dock.addPanel({ id: 'welcome', component: 'welcome', title: 'Welcome' });
                  }
                  if (route.kind === 'note') openNote(route.id);
                  else if (route.kind === 'graph') openGraph();

                  // Closing a note's tab (X, middle-click, delete, folder
                  // cascade) should also retire it from the URL — otherwise
                  // the route stays at /notes/:id, the explorer keeps the
                  // row highlighted, and refreshing reopens the tab. Land
                  // on home and clear currentNoteId.
                  dock.onDidRemovePanel((panel) => {
                    if (!panel.id.startsWith('note:')) return;
                    const closedId = panel.id.slice('note:'.length);
                    if (window.location.pathname === `/notes/${closedId}`) {
                      navigate({ kind: 'home' }, true);
                    }
                    setCurrentNoteId((prev) => (prev === closedId ? null : prev));
                  });
                }}
              />
            )}
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
