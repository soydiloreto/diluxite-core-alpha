import { useEffect, useState } from 'react';
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
  lang: 'en' | 'es';
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

const DEFAULTS: Prefs = {
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

/** User preferences (appearance + search), persisted in localStorage. */
export function useSettings() {
  const [prefs, setPrefs] = useState<Prefs>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--brand', prefs.accent);
    root.dataset.theme = prefs.theme;
  }, [prefs.accent, prefs.theme]);

  function setPref<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    setPrefs((p) => ({ ...p, [k]: v }));
  }

  return { prefs, setPref };
}
