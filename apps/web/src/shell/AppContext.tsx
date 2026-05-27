import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient, Folder, Note, TagCount } from '../api';
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
  openByTitle: (title: string) => Promise<void> | void;
  openGraph: () => void;
  openSettings: (tab?: string) => void;
  saveNote: (id: string, content: string) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  toggleFavorite: (id: string, value: boolean) => Promise<void>;
  /** Open the top-bar search pre-filled with `#<tag>` (drives tag-chip → notes flow). */
  searchTag: (tag: string) => void;
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
