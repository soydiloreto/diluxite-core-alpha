import { useEffect, useState } from 'react';
import type { SearchMode } from './api';

export interface Prefs {
  theme: 'oscuro' | 'claro';
  accent: string;
  searchMode: SearchMode;
  topK: number;
  lang: 'en' | 'es';
  sidebarWidth: number;
}

const DEFAULTS: Prefs = {
  theme: 'oscuro',
  accent: '#008671',
  searchMode: 'hybrid',
  topK: 5,
  lang: 'en',
  sidebarWidth: 288,
};
const KEY = 'diluxite.prefs';

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

/** Preferencias del usuario (apariencia + búsqueda), persistidas en localStorage. */
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
