import { useSyncExternalStore } from 'react';
import type { SearchMode } from './api';

/**
 * Where a companion panel (today: Neighbors) sits relative to the note body.
 *  - 'side'   — fixed sidebar on the right.
 *  - 'bottom' — stacked footer below.
 *  - 'hidden' — off; toggle from the panel header to bring it back.
 *
 * Mobile forces 'bottom' (a side split is unreadable on narrow viewports).
 * See NotePanel for the resolution logic.
 */
export type PreviewLayout = 'side' | 'bottom' | 'hidden';

export type NeighborsTab = 'outlinks' | 'backlinks' | 'related';

export interface Prefs {
  theme: 'dark' | 'light';
  accent: string;
  searchMode: SearchMode;
  topK: number;
  lang: 'en' | 'es' | 'pt' | 'it' | 'ca' | 'zh';
  sidebarWidth: number;
  /**
   * Neighbors panel default placement (sticky across notes):
   *  - 'hidden' — off; open it per note from the panel toggle.
   *  - 'side'   — fixed right sidebar next to the editor.
   *  - 'bottom' — stacked footer under the editor.
   */
  neighborsLayout: PreviewLayout;
  /** Neighbors panel: which tab was last active. */
  neighborsTab: NeighborsTab;
  /** Neighbors panel height (px) when stacked at the bottom. */
  neighborsHeight: number;
  /** Neighbors panel width (px) when docked as a side sidebar. */
  neighborsWidth: number;
}

/** Lighten (pct > 0) or darken (pct < 0) a `#rrggbb` hex by a percentage. */
function shadeHex(hex: string, pct: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + (pct / 100) * 255)));
  const r = adj((num >> 16) & 0xff);
  const g = adj((num >> 8) & 0xff);
  const b = adj(num & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export const DEFAULTS: Prefs = {
  theme: 'dark',
  accent: '#008671',
  searchMode: 'hybrid',
  topK: 5,
  lang: 'en',
  sidebarWidth: 288,
  neighborsLayout: 'hidden',
  neighborsTab: 'backlinks',
  neighborsHeight: 260,
  neighborsWidth: 320,
};
const KEY = 'diluxite.prefs';

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

// ── Shared store ─────────────────────────────────────────────────────────────
// Prefs are global app state: changing the language in Settings must reach the
// `useT()` hook in *every* component. A per-component `useState` would only
// update the one instance, so we keep a single module-level store and let all
// `useSettings()` callers subscribe via `useSyncExternalStore`.
let current: Prefs = load();
const listeners = new Set<() => void>();

/** Apply the visual prefs (theme + accent) to the document root. */
function applyTheme(p: Prefs): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  // The accent drives the whole UI's brand color via `--c-brand` (buttons,
  // active rows, links, highlights). We also derive a hover shade — lighter in
  // dark mode, darker in light — and keep the legacy `--brand` var that the
  // graph's range slider reads.
  root.style.setProperty('--c-brand', p.accent);
  root.style.setProperty('--brand', p.accent);
  root.style.setProperty('--c-brand-hover', shadeHex(p.accent, p.theme === 'dark' ? 14 : -14));
}

// Theme the very first paint.
applyTheme(current);

function commit(next: Prefs): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* localStorage may be unavailable (private mode); prefs stay in memory. */
  }
  applyTheme(current);
  listeners.forEach((l) => l());
}

/** Update a single preference (shared across all consumers). */
export function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
  commit({ ...current, [k]: v });
}

/** Reset every preference back to its default. */
export function resetPrefs(): void {
  commit({ ...DEFAULTS });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot(): Prefs {
  return current;
}

/** User preferences (appearance + search), shared + persisted in localStorage. */
export function useSettings() {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { prefs, setPref, resetPrefs };
}
