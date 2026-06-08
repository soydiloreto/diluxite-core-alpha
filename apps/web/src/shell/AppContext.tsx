import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient, Folder, Note, OrganizationWithRole, Space, TagCount } from '../api';
import type { Prefs } from '../useSettings';

/**
 * Central context for everything panels need to do their job without
 * prop-drilling through Dockview's component slots.
 *
 * Panels are mounted as Dockview "components" — they receive only
 * `{ params, api }` from the dock. Anything else (notes, helpers,
 * dialogs) flows through this context.
 */
export interface AppCtx {
  api: ApiClient;
  spaceId: string | null;
  /** Every workspace the user has membership of (across all orgs they belong to). */
  spaces: Space[];
  /** Every organization the user belongs to, with their per-org role. */
  organizations: OrganizationWithRole[];
  /** The active organization (drives the workspace selector + admin scoping). */
  currentOrgId: string | null;
  /**
   * Auth mode of the instance (mirrors `DILUXITE_AUTH_MODE` on the server).
   * Drives UX that depends on single-tenant vs multi-tenant — e.g. the
   * "delete organization" button is disabled in `local` because the API
   * also refuses it (single source of truth lives in the backend).
   */
  authMode: 'local' | 'server';
  /**
   * The currently authenticated user, or `null` in local mode (no login).
   * The shape mirrors what `/api/info` returns — only email today, used as
   * stable identity for collaborative awareness color hashing.
   */
  user: { email: string } | null;
  /**
   * Where the browser should open the collaborative editing WebSocket. Comes
   * from `/api/info` so the server decides whether collab is on for this
   * instance, no rebuild needed. `null` = collab disabled, single-user
   * editor only. Relative paths (`/collab`) are resolved against
   * `window.location`.
   */
  collabUrl: string | null;
  notes: Note[];
  folders: Folder[];
  tags: TagCount[];
  /**
   * Id of the note the user last navigated to. Persists across sidebar-view
   * switches (clicking the Backlinks / Tags / Recent icon doesn't reset it),
   * so context-sensitive panels can keep showing the right note.
   */
  currentNoteId: string | null;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
  getNote: (id: string) => Note | undefined;
  openNote: (id: string) => void;
  /** Pin the note's tab (stop it being the throwaway preview). Call on edit. */
  pinTab: (noteId: string) => void;
  openByTitle: (title: string) => Promise<void> | void;
  openGraph: () => void;
  openSettings: (tab?: string) => void;
  saveNote: (id: string, content: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  toggleFavorite: (id: string, value: boolean) => Promise<void>;
  /** Open the top-bar search pre-filled with `#<tag>` (drives tag-chip → notes flow). */
  searchTag: (tag: string) => void;
  /**
   * Re-fetch notes / folders / tags for the active workspace. Used after
   * bulk mutations (e.g. Search & Replace All) that bypass `saveNote()`.
   */
  refreshAll: () => Promise<void>;
  /**
   * ── Invalidation pattern ──────────────────────────────────────────────
   *
   * Any mutation that changes global state should call the matching
   * invalidator below — never reach into local component state to "guess"
   * what the rest of the app needs. This keeps the data flow one-directional:
   *
   *   mutation → API → refresh<X> → AppContext re-publishes → views re-render
   *
   * It is the single rule that makes "fix one screen at a time" unnecessary.
   * Documented in docs/PATTERNS.md.
   */
  refreshOrgs: () => Promise<void>;
  refreshSpaces: () => Promise<void>;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ value, children }: { value: AppCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
