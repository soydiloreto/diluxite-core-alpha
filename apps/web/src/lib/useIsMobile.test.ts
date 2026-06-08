import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

type Listener = (e: { matches: boolean }) => void;

/** Install a controllable matchMedia and return a setter to flip the match. */
function installMatchMedia(initial: boolean) {
  let matches = initial;
  let listener: Listener | null = null;
  window.matchMedia = vi.fn().mockImplementation(() => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, l: Listener) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = null;
    },
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    matches = next;
    listener?.({ matches: next });
  };
}

describe('useIsMobile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is true when the viewport matches the < md breakpoint', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('is false on a wide viewport', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('reacts to viewport changes', () => {
    const setMatch = installMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
    act(() => setMatch(true));
    expect(result.current).toBe(true);
  });
});
