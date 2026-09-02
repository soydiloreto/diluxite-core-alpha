import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-react';
import type { ApiClient, Folder, Note, OrganizationWithRole, Space, TagCount } from './api';
import { useSettings } from './useSettings';
import { useRoute, type Route } from './router';
import { makeSingleFlight } from './lib/singleFlight';
import { SettingsModal, type Tab as SettingsTab } from './layout/SettingsModal';
import { ActivityBar, type ActivityView } from './shell/ActivityBar';
import { Sidebar } from './shell/Sidebar';
import { DockShell } from './shell/DockShell';
import { AppProvider, type AppCtx } from './shell/AppContext';
import { TopBar, type TopBarHandle } from './shell/TopBar';
import { WorkspaceSelector } from './shell/WorkspaceSelector';
import { OrgIndicator } from './shell/OrgIndicator';
import { AdminConsole, type AdminSection } from './shell/admin/AdminConsole';
import { AdminSidebar } from './shell/admin/AdminSidebar';
import { AdminTabBar } from './shell/admin/AdminTabBar';
import { FavoritesView } from './shell/views/FavoritesView';
import { RecentView } from './shell/views/RecentView';
import { SearchView } from './shell/views/SearchView';
import { TrashView } from './shell/views/TrashView';
import { ArchiveView } from './shell/views/ArchiveView';
import { nextRailMode, type RailMode } from './shell/rail-layout';
import { ReviewView } from './shell/views/ReviewView';
import { StatusItem, StatusBar, useDialogs } from './ui';
import { useT } from './i18n';
import { Plug, Folder as FolderIcon } from './icons';
import { useIsMobile } from './lib/useIsMobile';
import { UpdateBanner } from './shell/UpdateBanner';

const SETTINGS_TABS: SettingsTab[] = [
  'appearance',
  'editor',
  'mcp',
  'security',
  'about',
];

type SidebarView = 'explorer' | 'favorites' | 'recent' | 'search' | 'trash' | 'archive' | 'review';

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
  const isMobile = useIsMobile();
  const t = useT();
  const { prefs, setPref } = useSettings();
  const [route, navigate] = useRoute();

  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [allSpaces, setAllSpaces] = useState<Space[]>([]);
  const [orgs, setOrgs] = useState<OrganizationWithRole[]>([]);
  // Active organization. Persists in localStorage so a hard refresh keeps the
  // user where they were. The TopBar OrgIndicator drives this; the AdminConsole
  // observes it via props (no internal picker).
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(
    () => (typeof localStorage !== 'undefined' && localStorage.getItem('diluxite.currentOrgId')) || null,
  );
  useEffect(() => {
    if (currentOrgId) localStorage.setItem('diluxite.currentOrgId', currentOrgId);
  }, [currentOrgId]);
  const [user, setUser] = useState<{ email: string } | null>(null);
  // Mirror of the backend's DILUXITE_AUTH_MODE. Drives UX gates (e.g. the
  // "delete organization" button is disabled in `local`). The backend is the
  // single source of truth — the matching API guards refuse the same ops with
  // a 403 regardless of what the UI shows.
  const [authMode, setAuthMode] = useState<'local' | 'server'>('local');
  // Running version (from /api/info). A pre-release tag (contains a `-`, e.g.
  // `1.0.0-alpha.55`) means the `next` channel; a clean release means `latest`.
  const [version, setVersion] = useState('');
  const channel: 'next' | 'latest' | null = version ? (version.includes('-') ? 'next' : 'latest') : null;
  const [collabUrl, setCollabUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  // Mobile-first: at narrow viewports the sidebar starts collapsed so the
  // editor (or admin section) gets the full width. md+ defaults to open.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => (typeof window !== 'undefined' ? window.innerWidth >= 768 : true),
  );
  /**
   * How the activity rail shows itself. Persisted: it is a preference about
   * the shell, not about where you are.
   */
  const [railMode, setRailMode] = useState<RailMode>(() => {
    try {
      const s = window.localStorage.getItem('diluxite_rail_mode');
      return s === 'auto' || s === 'expanded' || s === 'collapsed' ? s : 'auto';
    } catch {
      return 'auto';
    }
  });
  const cycleRail = useCallback(() => {
    setRailMode((m) => {
      const next = nextRailMode(m);
      try {
        window.localStorage.setItem('diluxite_rail_mode', next);
      } catch {
        // A browser refusing storage still gets the toggle, just not the memory.
      }
      return next;
    });
  }, []);
  const topBarRef = useRef<TopBarHandle>(null);

  // Sidebar policy on /admin:
  //  - desktop: MUST be open (it hosts the section list).
  //  - mobile : MUST be closed (section list is rendered inline as an
  //             AdminTabBar at the top of the main area; the drawer
  //             would either steal screen real-estate or vanish on
  //             backdrop tap, leaving the user stranded).
  useEffect(() => {
    if (route.kind === 'admin') setSidebarOpen(!isMobile);
  }, [route.kind, isMobile]);
  // The view shown in the sidebar (Activity bar selection). 'explorer' is the
  // default Folders + notes tree; the others are the new top-level lists.
  const [sidebarView, setSidebarView] = useState<SidebarView>('explorer');
  // Seed for the Search view when arriving via a #tag click (q + a bumping
  // nonce so re-clicking the same tag re-applies the query).
  const [searchSeed, setSearchSeed] = useState<{ q: string; nonce: number } | undefined>(undefined);
  const searchNonce = useRef(0);
  // Last note the user navigated to. Persists across sidebar-view switches
  // (clicking Backlinks / Tags / Recent doesn't reset it) so the dependent
  // panels can keep showing the right note. Reset by deleteNote when it
  // matches the note being removed.
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);

  const dockRef = useRef<DockviewApi | null>(null);
  // Coalesce concurrent "create missing note" clicks by title, so a rapid
  // double-click can't race the optimistic insert and spawn duplicate notes.
  const createByTitle = useRef(makeSingleFlight<Note>()).current;
  // VS Code-style preview tab: the id of the single transient note panel. A
  // note opened (not edited) is a preview; opening another replaces it instead
  // of piling up. Editing the note "pins" it (clears this), so it survives.
  const previewId = useRef<string | null>(null);

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
      setAuthMode(info.authMode ?? 'local');
      setCollabUrl(info.collabUrl ?? null);
      setVersion(info.version ?? '');
      // Resolve the active org: keep the persisted choice if it's still valid,
      // otherwise fall back to the first one the user belongs to.
      const persistedOrg = orgList.find((o) => o.id === currentOrgId);
      const activeOrg = persistedOrg ?? orgList[0] ?? null;
      if (activeOrg && activeOrg.id !== currentOrgId) setCurrentOrgId(activeOrg.id);
      // Pick a workspace inside the active org if possible.
      const orgSpaces = activeOrg
        ? spaces.filter((s) => !s.orgId || s.orgId === activeOrg.id)
        : spaces;
      const sid = orgSpaces[0]?.id ?? spaces[0]?.id ?? null;
      setSpaceId(sid);
      if (sid) await refresh(sid);
    })();
    // `currentOrgId` is read at boot to honour the persisted choice. We do
    // NOT want this effect to re-fire when the user later switches org —
    // switchOrg handles that path with the right side-effects.
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
    () => orgs.some((o) => o.role === 'org_admin' || o.role === 'org_member'),
    [orgs],
  );

  const currentOrg = useMemo(
    () => orgs.find((o) => o.id === currentOrgId) ?? null,
    [orgs, currentOrgId],
  );

  // Workspaces filtered to the active org (transitional check tolerates
  // pre-v4.1 rows without orgId surfaced by listSpaces).
  const orgWorkspaces = useMemo(
    () => (currentOrg ? allSpaces.filter((s) => !s.orgId || s.orgId === currentOrg.id) : allSpaces),
    [allSpaces, currentOrg],
  );

  /**
   * Switching org: refresh the list of workspaces scoped to the new org,
   * pick the first one (or keep the current if it belongs to it), and reset
   * the open tabs. Persisted across reloads via the currentOrgId effect.
   */
  const switchOrg = useCallback(
    async (nextOrgId: string) => {
      if (nextOrgId === currentOrgId) return;
      setCurrentOrgId(nextOrgId);
      try {
        const orgSpaces = await api.listOrgWorkspaces(nextOrgId);
        // Merge into allSpaces so the workspace selector sees them next render.
        setAllSpaces((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const s of orgSpaces) byId.set(s.id, s);
          return Array.from(byId.values());
        });
        const next = orgSpaces[0]?.id ?? null;
        if (next && next !== spaceId) {
          await switchWorkspace(next);
        } else if (!next) {
          // Org with zero accessible workspaces — clear current state.
          setSpaceId(null);
          setNotes([]);
          setFolders([]);
          setTags([]);
          navigate({ kind: 'admin', section: 'workspaces' });
        }
      } catch (e) {
        console.error('switchOrg failed', e);
      }
    },
    [api, currentOrgId, spaceId, switchWorkspace, navigate],
  );

  /**
   * Create a new organization (server mode only — the API guards reject it
   * in local). Prompts for a name, slug is derived server-side, then refreshes
   * the org list and switches into the freshly created one.
   */
  const createOrgFlow = useCallback(async () => {
    const name = await dialogs.prompt('New organization', {
      placeholder: 'Acme Inc.',
      okLabel: 'Create',
    });
    if (!name) return;
    try {
      const fresh = await api.createOrganization(name);
      const orgList = await api.listOrganizations();
      setOrgs(orgList);
      await switchOrg(fresh.id);
    } catch (e) {
      console.error('createOrganization failed', e);
      await dialogs.confirm("Couldn't create organization", {
        message: e instanceof Error ? e.message : String(e),
        okLabel: 'Got it',
      });
    }
  }, [api, dialogs, switchOrg]);

  // ── Dock helpers ───────────────────────────────────────────────────────
  const getNote = useCallback((id: string) => notes.find((n) => n.id === id), [notes]);

  const openNote = useCallback(
    // `noteHint` is an out-of-band escape hatch for the createNote flow: when
    // we just inserted a row, `notes` in our closure can still be the stale
    // list (React batches the setNotes update), so `notes.find()` returns
    // undefined and the new tab silently fails to open. Passing the fresh
    // Note as the second arg sidesteps the closure entirely.
    (id: string, noteHint?: Note) => {
      navigate({ kind: 'note', id });
      // On mobile the sidebar is a drawer that occupies most of the viewport
      // — opening a note while it's still up means the user can't actually
      // read what they just opened. Auto-dismiss it.
      if (isMobile) setSidebarOpen(false);
      const dock = dockRef.current;
      const note = noteHint ?? notes.find((n) => n.id === id);
      if (!dock || !note) return;
      const targetId = `note:${id}`;
      const existing = dock.getPanel(targetId);
      if (existing) {
        existing.api.setActive();
        return;
      }
      // New note → open it as the preview tab, then evict the previous preview
      // (a tab the user only looked at, never edited) so previews don't pile up.
      const prevPreview = previewId.current;
      dock.addPanel({
        id: targetId,
        component: 'note',
        title: note.title,
        params: { noteId: id },
      });
      previewId.current = targetId;
      if (prevPreview && prevPreview !== targetId) {
        const p = dock.getPanel(prevPreview);
        if (p) dock.removePanel(p);
      }
    },
    [notes, navigate, isMobile],
  );

  // Pin the current note's tab so it stops being the throwaway preview — called
  // when the user edits it. After this, opening another note won't replace it.
  const pinTab = useCallback((noteId: string) => {
    if (previewId.current === `note:${noteId}`) previewId.current = null;
  }, []);

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
    (v: 'favorites' | 'recent' | 'search' | 'trash' | 'archive' | 'review') => {
      setSidebarView(v);
      setSidebarOpen(true);
      navigate({ kind: v } as Route);
    },
    [navigate],
  );

  // ── Mutations ──────────────────────────────────────────────────────────
  async function createNote(folderId: string | null) {
    // Global "+ New note" affordances (TopBar, ActivityBar, Sidebar header,
    // window event) pass `null`. Instead of always creating at workspace
    // root, drop the new note into the same folder as the note the user is
    // currently reading — matches "I'm here, create next to this". Per-
    // folder buttons (NotesTree "new note here") still pass a real
    // folderId and are unaffected.
    const target = folderId ?? notes.find((n) => n.id === currentNoteId)?.folderId ?? null;
    const title = await dialogs.prompt('New note', { placeholder: 'Title…', okLabel: 'Create' });
    if (!title || !spaceId) return;
    const n = await api.createNote(spaceId, title.trim(), `# ${title.trim()}\n\n`, target);
    // Optimistic insert into the local state so the sidebar reflects it
    // immediately AND so `openNote(n.id, n)` doesn't trip over a stale
    // `notes` closure when reading the title for the new Dockview panel.
    // `refresh()` then reconciles with the server (sorts, computes counts).
    setNotes((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev]));
    openNote(n.id, n);
    void refresh(spaceId);
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
        message: `«${note.title}» will be moved to Trash. You can restore it from there.`,
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

  /**
   * Open today's page, creating it the first time each day.
   *
   * The timezone offset travels with the request because the browser is the
   * only party that knows it — the server's midnight is not the user's, and a
   * page that appears hours early is one people stop trusting.
   */
  const openDaily = useCallback(async () => {
    if (!spaceId) return;
    const { note, created } = await api.openDaily(spaceId, {
      tzOffsetMinutes: new Date().getTimezoneOffset(),
    });
    if (created) await refresh(spaceId);
    openNote(note.id);
  }, [api, spaceId, refresh, openNote]);

  async function toggleArchive(id: string, value: boolean) {
    const upd = await api.setArchived(id, value);
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

  // Multi-select move: one atomic request for the whole selection (notes +
  // folders → one destination), then a single refresh. The server rejects
  // folder cycles as a unit, so a friendly message replaces the raw HTTP error.
  const moveItems = useCallback(
    async (targetFolderId: string | null, noteIds: string[], folderIds: string[]) => {
      if (!spaceId || (noteIds.length === 0 && folderIds.length === 0)) return;
      try {
        await api.moveItems(spaceId, { targetFolderId, noteIds, folderIds });
        await refresh(spaceId);
      } catch (e) {
        await dialogs.confirm("Couldn't move the selection", {
          message:
            'The destination is one of the selected folders or a descendant of it. Pick a different target.',
        });
      }
    },
    [api, spaceId, refresh, dialogs],
  );

  // Bulk delete from the explorer selection (Delete key or the context menu).
  // Notes are soft-deleted, folders are not: one dialog has to state both.
  const deleteItems = useCallback(
    async (noteIds: string[], folderIds: string[]) => {
      if (!spaceId || (noteIds.length === 0 && folderIds.length === 0)) return;
      const parts: string[] = [];
      if (folderIds.length > 0) {
        parts.push(
          `${folderIds.length} folder${folderIds.length > 1 ? 's' : ''} and everything ` +
            'inside (notes and subfolders) will be permanently deleted.',
        );
      }
      if (noteIds.length > 0) {
        parts.push(
          `${noteIds.length} note${noteIds.length > 1 ? 's' : ''} will be moved to Trash, ` +
            'where you can restore them.',
        );
      }
      const total = noteIds.length + folderIds.length;
      const ok = await dialogs.confirm(`Delete ${total} item${total > 1 ? 's' : ''}?`, {
        message: parts.join(' '),
        danger: true,
      });
      if (!ok) return;

      const dock = dockRef.current;
      for (const id of noteIds) {
        const panel = dock?.getPanel(`note:${id}`);
        if (panel) dock!.removePanel(panel);
      }
      if (noteIds.length > 0) await api.deleteMany(noteIds);
      for (const id of folderIds) await api.deleteFolder(id);
      await refresh(spaceId);
      setCurrentNoteId((prev) => (prev && noteIds.includes(prev) ? null : prev));
    },
    [api, spaceId, refresh, dialogs],
  );

  // Bulk tag from the explorer selection.
  //
  // The server edits each note's markdown — tags are derived from the body on
  // every save, so rows written behind the text would not survive the next
  // edit. That is also why this reports what it did: some of the selection may
  // already carry the tag, and "12 notes, 3 already had it" is the honest
  // answer to a selection made by dragging.
  const tagItems = useCallback(
    async (noteIds: string[]) => {
      if (!spaceId || noteIds.length === 0) return;
      const raw = await dialogs.prompt(`Tag ${noteIds.length} notes`, {
        placeholder: 'tag (without the #)',
        okLabel: 'Add tag',
      });
      const tag = raw?.trim();
      if (!tag) return;
      try {
        const r = await api.tagMany(noteIds, { add: [tag] });
        await refresh(spaceId);
        if (r.unchanged > 0 || r.refused > 0) {
          const parts = [`${r.updated} tagged`];
          if (r.unchanged > 0) parts.push(`${r.unchanged} already had it`);
          if (r.refused > 0) parts.push(`${r.refused} not yours`);
          await dialogs.confirm(`#${tag}`, { message: parts.join(' · '), okLabel: 'OK' });
        }
      } catch {
        await dialogs.confirm("Couldn't tag the selection", {
          message: `"${tag}" has to start with a letter and carry no spaces.`,
          okLabel: 'OK',
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
    const key = title.trim().toLowerCase();
    // Case-insensitive match so "Event Sourcing" and "event sourcing" don't
    // both spawn notes.
    const found = notes.find((n) => n.title.trim().toLowerCase() === key);
    if (found) return openNote(found.id);
    if (!spaceId) return;
    // Concurrent clicks for the same title share one create → no duplicates.
    const n = await createByTitle(key, () =>
      api.createNote(spaceId, title, `# ${title}\n\n`),
    );
    // Same stale-closure pattern as createNote(): optimistic insert + open
    // with the fresh note hint so the new wikilink target tab actually opens.
    setNotes((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev]));
    openNote(n.id, n);
    void refresh(spaceId);
  }

  // ── URL → Dock / Sidebar sync ──────────────────────────────────────────
  // The router owns the "deep" view state (note / graph / settings + the
  // sidebar-only views favorites / recent / tags / backlinks). Mirror it.
  useEffect(() => {
    if (route.kind === 'note') {
      setCurrentNoteId(route.id);
      openNote(route.id);
    } else if (route.kind === 'graph') openGraph();
    else if (
      route.kind === 'favorites' ||
      route.kind === 'recent' ||
      route.kind === 'search' ||
      route.kind === 'trash' ||
      route.kind === 'archive' ||
      route.kind === 'review'
    ) {
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
  // clicked tab to a panel by its dockview id (stamped on the tab as
  // `data-panel-id` by CustomTab). Resolving by title is unsafe — note titles
  // aren't unique, so a homonymous tab could get closed by mistake.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 1) return;
      const dock = dockRef.current;
      if (!dock) return;
      const tab = (e.target as HTMLElement | null)?.closest('[data-panel-id]');
      const panelId = tab?.getAttribute('data-panel-id');
      if (!panelId) return;
      const panel = dock.panels.find((p) => p.id === panelId);
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

  // DockShell is mounted for the whole lifetime of App now (it's only hidden
  // on /admin, never unmounted), so the only real teardown is App unmounting.
  // Null the ref then so nothing keeps poking a disposed dock.
  useEffect(() => {
    return () => {
      dockRef.current = null;
    };
  }, []);

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

  // `createNote` is recreated every render and closes over `notes` /
  // `currentNoteId`, so it must not be captured once. Keep the latest version
  // in a ref (refreshed each render) and have the global listener call through
  // it — otherwise "New note" from the WelcomePanel uses stale state and drops
  // the note in the wrong folder (or root).
  const createNoteRef = useRef(createNote);
  createNoteRef.current = createNote;
  useEffect(() => {
    const h = () => void createNoteRef.current(null);
    window.addEventListener('diluxite:new-note', h);
    return () => window.removeEventListener('diluxite:new-note', h);
  }, []);

  // ── Settings modal state ───────────────────────────────────────────────
  const settingsOpen = route.kind === 'settings';
  const settingsTab: SettingsTab =
    route.kind === 'settings' && route.tab && (SETTINGS_TABS as string[]).includes(route.tab)
      ? (route.tab as SettingsTab)
      : 'appearance';

  const activeView: ActivityView | null =
    route.kind === 'graph'
      ? 'graph'
      : route.kind === 'settings'
        ? 'settings'
        : route.kind === 'admin'
          ? 'admin'
          : route.kind === 'favorites' ||
              route.kind === 'recent' ||
              route.kind === 'search' ||
              route.kind === 'trash' ||
              route.kind === 'archive' ||
              route.kind === 'review'
            ? route.kind
            : 'explorer';

  // Clicking a #tag (in a note, or "see all" from the top bar) lands on the
  // full Search view seeded with `#tag`, which already matches every note that
  // carries it — instead of the top bar's necessarily-truncated dropdown.
  const searchTag = useCallback(
    (tag: string) => {
      setSearchSeed({ q: `#${tag}`, nonce: searchNonce.current++ });
      setSidebarView('search');
      setSidebarOpen(true);
      navigate({ kind: 'search' });
    },
    [navigate],
  );

  // ── Invalidation pattern (docs/PATTERNS.md) ────────────────────────────
  // Each invalidator re-fetches one scope from the API and republishes it
  // through the AppContext. Admin views call them after any mutation; the
  // App owns the canonical state and pushes the new value back down.

  /** Notes / folders / tags for the active workspace. */
  const refreshAll = useCallback(async () => {
    if (spaceId) await refresh(spaceId);
  }, [spaceId, refresh]);

  /**
   * Organisations the user belongs to (re-derives current role + name).
   *
   * Reconciles the active org afterwards: if the user just deleted (or got
   * kicked from) the org they had selected, currentOrgId becomes a ghost
   * pointer — currentOrg resolves to null, workspaces filter to empty, the
   * UI looks broken. We switch to the first available org instead, or
   * clear the selection if there are none.
   */
  const refreshOrgs = useCallback(async () => {
    const fresh = await api.listOrganizations();
    setOrgs(fresh);
    if (currentOrgId && !fresh.find((o) => o.id === currentOrgId)) {
      if (fresh.length > 0) {
        await switchOrg(fresh[0].id);
      } else {
        setCurrentOrgId(null);
        try {
          localStorage.removeItem('diluxite.currentOrgId');
        } catch {
          /* ignore */
        }
      }
    }
  }, [api, currentOrgId, switchOrg]);

  /**
   * Workspaces visible to the user (across all orgs they belong to).
   *
   * Reconciles the active workspace afterwards, mirroring refreshOrgs: if the
   * active spaceId just vanished (e.g. the user deleted the workspace they
   * were in), `refreshAll()` would call listNotes() on a dead id and the UI
   * would keep showing ghost data. Switch to the first available workspace
   * instead, or clear all dependent state if none remain.
   */
  const refreshSpaces = useCallback(async () => {
    const fresh = await api.listSpaces();
    setAllSpaces(fresh);
    if (spaceId && !fresh.some((s) => s.id === spaceId)) {
      const next = fresh[0]?.id ?? null;
      if (next) {
        await switchWorkspace(next);
      } else {
        setSpaceId(null);
        setNotes([]);
        setFolders([]);
        setTags([]);
      }
    }
  }, [api, spaceId, switchWorkspace]);

  const ctx: AppCtx = useMemo(
    () => ({
      api,
      spaceId,
      spaces: allSpaces,
      organizations: orgs,
      currentOrgId,
      authMode,
      user,
      collabUrl,
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
      pinTab,
      saveNote,
      deleteNote,
      toggleFavorite,
      toggleArchive,
      searchTag,
      refreshAll,
      refreshOrgs,
      refreshSpaces,
    }),
    [
      api, spaceId, allSpaces, orgs, currentOrgId, authMode, user, collabUrl, notes, folders, tags, currentNoteId,
      prefs, getNote, openNote, pinTab, openGraph, openSettings, deleteNote, searchTag,
      refreshAll, refreshOrgs, refreshSpaces,
    ],
  );

  // Pick the body component for the sidebar.
  // The sidebar body swaps with the active "activity". Admin replaces the
  // Explorer entirely (no double-sidebar) — matches VS Code's pattern where
  // each activity owns the same panel slot.
  const sidebarBody = (() => {
    if (route.kind === 'admin') {
      return (
        <AdminSidebar
          org={currentOrg}
          section={(route.section as AdminSection | undefined) ?? 'organization'}
          onSection={(s) => navigate({ kind: 'admin', section: s })}
        />
      );
    }
    switch (sidebarView) {
      case 'favorites':
        return <FavoritesView />;
      case 'recent':
        return <RecentView />;
      case 'search':
        return <SearchView seed={searchSeed} />;
      case 'trash':
        return <TrashView />;
      case 'archive':
        return <ArchiveView />;
      case 'review':
        return <ReviewView />;
      case 'explorer':
      default:
        return (
          <Sidebar
            currentNoteId={route.kind === 'note' ? route.id : null}
            onCreateNote={createNote}
            onCreateFolder={createFolder}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            onDeleteNote={confirmDeleteNote}
            onRenameNote={renameNote}
            onToggleFavorite={toggleFavoriteByNote}
            onMoveNoteToFolder={moveNoteToFolder}
            onMoveFolderToFolder={moveFolderToFolder}
            onMoveItems={moveItems}
            onDeleteItems={deleteItems}
            onTagItems={tagItems}
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
        <UpdateBanner />
        <TopBar
          ref={topBarRef}
          onNewNote={() => createNote(null)}
          onNewFolder={() => createFolder(null)}
          onNewWorkspace={() => navigate({ kind: 'admin', section: 'workspaces' })}
          onOpenAdmin={
            orgs.some((o) => o.role === 'org_admin')
              ? () => navigate({ kind: 'admin' })
              : undefined
          }
          workspaceSelector={
            orgWorkspaces.length > 0 ? (
              <WorkspaceSelector
                workspaces={orgWorkspaces}
                activeId={spaceId}
                onPick={(id) => void switchWorkspace(id)}
                onManage={() => navigate({ kind: 'admin', section: 'workspaces' })}
              />
            ) : null
          }
          orgIndicator={
            orgs.length > 0 ? (
              <OrgIndicator
                orgs={orgs}
                currentOrgId={currentOrgId}
                authMode={authMode}
                onPick={(id) => void switchOrg(id)}
                onCreate={() => void createOrgFlow()}
              />
            ) : null
          }
        />
        <div className="flex-1 min-h-0 flex relative">
          <ActivityBar
            active={activeView}
            user={user}
            channel={channel}
            sidebarOpen={sidebarOpen}
            railMode={railMode}
            onCycleRail={cycleRail}
            showAdmin={canSeeAdmin}
            onToggleSidebar={() => {
              // Clicking Explorer again is a no-op, deliberately. It used to
              // close the panel, so a second click made the notes vanish —
              // which reads as losing them, not as tidying up.
              setSidebarView('explorer');
              setSidebarOpen(true);
              navigate({ kind: 'home' });
            }}
            onHome={() => {
              setSidebarView('explorer');
              navigate({ kind: 'home' });
              // Always surface the Welcome tab on a brand-click — gives the
              // user a stable "home" landing with stats + quick actions.
              const dock = dockRef.current;
              if (dock) {
                const existing = dock.getPanel('welcome');
                if (existing) existing.api.setActive();
                else dock.addPanel({ id: 'welcome', component: 'welcome', title: 'Welcome' });
              }
            }}
            onGraph={openGraph}
            onView={openSidebarView}
            onNew={() => createNote(null)}
            onDaily={() => void openDaily()}
            onAdmin={() => navigate({ kind: 'admin' })}
            onSettings={() => openSettings()}
            onAccount={(tab) => openSettings(tab)}
          />

          {sidebarOpen && (
            <>
              {/* Mobile-only backdrop. Bounded to the area RIGHT of the
                  activity bar so the user can still tap a different activity
                  to switch instead of having to dismiss first. */}
              <button
                type="button"
                aria-label="close sidebar"
                onClick={() => setSidebarOpen(false)}
                className="md:hidden fixed top-9 left-12 right-0 bottom-0 z-20 bg-black/50"
              />
              <aside
                data-testid="left-dock"
                style={{ ['--sidebar-w' as string]: `${prefs.sidebarWidth}px` }}
                className="
                  fixed top-9 bottom-0 left-12 z-30 w-[80vw] max-w-[320px] shadow-2xl
                  md:static md:h-full md:w-[var(--sidebar-w)] md:max-w-none md:shadow-none md:z-auto
                  shrink-0 border-r border-line bg-bg-surface overflow-hidden
                "
              >
                {sidebarBody}
              </aside>
              {/* Resize handle: desktop only. */}
              <div className="hidden md:block">
                <ResizeHandle
                  left={48 + prefs.sidebarWidth - 3 /* activity bar + sidebar */}
                  onResize={(w) => setPref('sidebarWidth', Math.max(180, Math.min(560, w - 48)))}
                />
              </div>
            </>
          )}

          <main className="flex-1 min-w-0 h-full relative" data-testid="main">
            {/* DockShell is mounted UNCONDITIONALLY so that navigating to
                /admin never tears down dockview (which would dispose the dock,
                lose every open tab, and leave dockRef pointing at a disposed
                instance that the notes/switchWorkspace effects keep poking).
                On /admin we hide the dock with `display:none` and float the
                Admin console on top as an overlay. */}
            <div className={route.kind === 'admin' ? 'hidden' : 'absolute inset-0'}>
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
                    if (previewId.current === panel.id) previewId.current = null;
                    if (!panel.id.startsWith('note:')) return;
                    const closedId = panel.id.slice('note:'.length);
                    if (window.location.pathname === `/notes/${closedId}`) {
                      navigate({ kind: 'home' }, true);
                    }
                    setCurrentNoteId((prev) => (prev === closedId ? null : prev));
                  });

                  // Activating a tab (clicking a tab header, or dockview moving
                  // focus after a close) must ALSO drive the URL — otherwise the
                  // explorer keeps the previous row highlighted and you lose
                  // track of which note you're on. Sync the active panel → route.
                  // dockview 8 wraps this payload: the event carries
                  // `{ panel, origin }` where v6 handed over the panel itself.
                  dock.onDidActivePanelChange((event) => {
                    const pid = event?.panel?.id;
                    if (!pid) return;
                    if (pid.startsWith('note:')) {
                      const id = pid.slice('note:'.length);
                      setCurrentNoteId(id);
                      if (window.location.pathname !== `/notes/${id}`) {
                        navigate({ kind: 'note', id });
                      }
                    } else if (pid === 'graph' && window.location.pathname !== '/graph') {
                      navigate({ kind: 'graph' });
                    }
                  });
                }}
              />
            </div>
            {route.kind === 'admin' && (
              <div className="absolute inset-0 h-full flex flex-col min-w-0 bg-bg">
                {/* Mobile-only inline navigation — replaces the dismissible
                    drawer pattern so the user can always switch sections. */}
                {isMobile && (
                  <AdminTabBar
                    org={currentOrg}
                    section={(route.section as AdminSection | undefined) ?? 'organization'}
                    onSection={(s) => navigate({ kind: 'admin', section: s })}
                  />
                )}
                <div className="flex-1 min-h-0">
                  <AdminConsole
                    org={currentOrg}
                    section={
                      (route.section as AdminSection | undefined) ?? 'organization'
                    }
                    prefs={prefs}
                    setPref={setPref}
                  />
                </div>
              </div>
            )}
          </main>
        </div>

        <StatusBar>
          <StatusItem onClick={() => openSettings('mcp')} title="MCP ready — click for connection details">
            <Plug size={12} className="text-emerald-400" /> {t('status.mcp').replace('🟢 ', '')}
          </StatusItem>
          <StatusItem title="Current workspace">
            <FolderIcon size={12} /> {allSpaces.find((s) => s.id === spaceId)?.name ?? '—'}
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
