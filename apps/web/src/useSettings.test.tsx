import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSettings, setPref, resetPrefs, DEFAULTS } from './useSettings';
import { LANGS, LANG_LABELS } from './i18n';

/**
 * Guards the bug where changing a preference (e.g. language) in Settings did
 * NOT reach other components: `useSettings` was per-component state. It is now
 * a shared store, so every consumer sees the same value.
 */
describe('useSettings — shared store', () => {
  beforeEach(() => {
    resetPrefs();
  });

  it('two separate consumers observe the same update', () => {
    const a = renderHook(() => useSettings());
    const b = renderHook(() => useSettings());
    act(() => a.result.current.setPref('lang', 'pt'));
    expect(a.result.current.prefs.lang).toBe('pt');
    // Used to stay stale ('en') — this is the language-switch regression.
    expect(b.result.current.prefs.lang).toBe('pt');
  });

  it('accent drives the UI brand color via --c-brand (not the dead --brand only)', () => {
    act(() => setPref('accent', '#ff0000'));
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--c-brand')).toBe('#ff0000');
    expect(root.style.getPropertyValue('--brand')).toBe('#ff0000'); // legacy graph slider
  });

  it('theme sets the data-theme attribute', () => {
    act(() => setPref('theme', 'light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resetPrefs restores every default', () => {
    act(() => {
      setPref('theme', 'light');
      setPref('accent', '#123456');
      setPref('lang', 'zh');
    });
    act(() => resetPrefs());
    const { result } = renderHook(() => useSettings());
    expect(result.current.prefs.theme).toBe(DEFAULTS.theme);
    expect(result.current.prefs.accent).toBe(DEFAULTS.accent);
    expect(result.current.prefs.lang).toBe(DEFAULTS.lang);
  });
});

describe('i18n languages', () => {
  it('offers the six languages with native labels', () => {
    expect(LANGS).toEqual(['en', 'es', 'pt', 'it', 'ca', 'zh']);
    expect(LANG_LABELS.es).toBe('Español');
    expect(LANG_LABELS.pt).toBe('Português');
    expect(LANG_LABELS.it).toBe('Italiano');
    expect(LANG_LABELS.ca).toBe('Català');
    expect(LANG_LABELS.zh).toBe('中文');
  });
});
