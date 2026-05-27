import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient, Carpeta, Note, TagCount } from '../api';
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
  carpetas: Carpeta[];
  tags: TagCount[];
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
