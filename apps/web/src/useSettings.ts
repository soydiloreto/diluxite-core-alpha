import { useSyncExternalStore } from 'react';
import type { SearchMode } from './api';

/**
 * Where the Markdown preview sits relative to the editor on desktop.
 *  - 'side'   — side-by-side, two columns (the historical default).
 *  - 'bottom' — stacked, editor on top, preview below.
 *  - 'hidden' — editor only; toggle from the panel header to bring the preview back.
 *
 * Mobile ignores this and forces 'bottom' (a 50/50 horizontal split is
 * unreadable on narrow viewports). See NotePanel for the resolution logic.
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
  previewLayout: PreviewLayout;
  /**
   * Editor / preview split (% the editor takes when both panes are visible).
   * Drag the splitter in the note panel to change.
   */
  previewSplitPct: number;
  /** Neighbors panel: open across every note (sticky toggle). */
  neighborsOpen: boolean;
  /** Neighbors panel: which tab was last active. */
  neighborsTab: NeighborsTab;
  /** Neighbors panel height (px). Drag the top edge to resize. */
  neighborsHeight: number;
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
  // Hidden by default: preview only appears when the user asks for it via
  // the Eye toggle. Once visible, its orientation (side / bottom) is
  // remembered and applied to every note tab.
  previewLayout: 'hidden',
  previewSplitPct: 50,
  neighborsOpen: false,
  neighborsTab: 'backlinks',
  neighborsHeight: 260,
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
