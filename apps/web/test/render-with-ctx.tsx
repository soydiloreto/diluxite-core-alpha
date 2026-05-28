import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ApiClient,
  Folder,
  Note,
  OrganizationWithRole,
  Space,
  TagCount,
} from '../src/api';
import { DialogProvider } from '../src/ui';
import { AppProvider, type AppCtx } from '../src/shell/AppContext';
import type { Prefs } from '../src/useSettings';

const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  accent: '#008671',
  searchMode: 'hybrid',
  topK: 5,
  lang: 'en',
  sidebarWidth: 288,
  previewLayout: 'side',
};

export interface TestCtxOverrides {
  api?: ApiClient;
  spaceId?: string | null;
  spaces?: Space[];
  organizations?: OrganizationWithRole[];
  currentOrgId?: string | null;
  notes?: Note[];
  folders?: Folder[];
  tags?: TagCount[];
  currentNoteId?: string | null;
  prefs?: Prefs;
  openNote?: AppCtx['openNote'];
  openByTitle?: AppCtx['openByTitle'];
  openGraph?: AppCtx['openGraph'];
  openSettings?: AppCtx['openSettings'];
  saveNote?: AppCtx['saveNote'];
  deleteNote?: AppCtx['deleteNote'];
  toggleFavorite?: AppCtx['toggleFavorite'];
  searchTag?: AppCtx['searchTag'];
  refreshAll?: AppCtx['refreshAll'];
  refreshOrgs?: AppCtx['refreshOrgs'];
  refreshSpaces?: AppCtx['refreshSpaces'];
  setPref?: AppCtx['setPref'];
}

/** Build a minimal AppCtx using sensible no-op defaults for what isn't overridden. */
export function buildCtx(o: TestCtxOverrides = {}): AppCtx {
  const notes = o.notes ?? [];
  const folders = o.folders ?? [];
  return {
    api: o.api ?? ({} as ApiClient),
    spaceId: o.spaceId ?? 'space-1',
    spaces: o.spaces ?? [],
    organizations: o.organizations ?? [],
    currentOrgId: o.currentOrgId ?? null,
    notes,
    folders,
    tags: o.tags ?? [],
    currentNoteId: o.currentNoteId ?? null,
    prefs: o.prefs ?? DEFAULT_PREFS,
    setPref: o.setPref ?? (() => {}),
    getNote: (id) => notes.find((n) => n.id === id),
    openNote: o.openNote ?? (() => {}),
    openByTitle: o.openByTitle ?? (() => {}),
    openGraph: o.openGraph ?? (() => {}),
    openSettings: o.openSettings ?? (() => {}),
    saveNote: o.saveNote ?? (async () => {}),
    deleteNote: o.deleteNote ?? (async () => {}),
    toggleFavorite: o.toggleFavorite ?? (async () => {}),
    searchTag: o.searchTag ?? (() => {}),
    refreshAll: o.refreshAll ?? (async () => {}),
    refreshOrgs: o.refreshOrgs ?? (async () => {}),
    refreshSpaces: o.refreshSpaces ?? (async () => {}),
  };
}

/** Render `node` inside DialogProvider + AppProvider with the given ctx overrides. */
export function renderWithCtx(node: ReactNode, overrides: TestCtxOverrides = {}): RenderResult & { ctx: AppCtx } {
  const ctx = buildCtx(overrides);
  const result = render(
    <DialogProvider>
      <AppProvider value={ctx}>{node}</AppProvider>
    </DialogProvider>,
  );
  return Object.assign(result, { ctx });
}

let noteSeq = 0;
/** Factory for a Note with sensible defaults. */
export function makeNote(over: Partial<Note> = {}): Note {
  noteSeq += 1;
  const now = new Date().toISOString();
  return {
    id: `n${noteSeq}`,
    spaceId: 'space-1',
    folderId: null,
    title: `Note ${noteSeq}`,
    contentMd: '',
    favorite: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}
