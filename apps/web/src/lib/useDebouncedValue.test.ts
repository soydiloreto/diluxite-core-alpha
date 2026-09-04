import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value settled, with nothing pending', () => {
    const { result } = renderHook(() => useDebouncedValue('a', 200));
    expect(result.current.value).toBe('a');
    expect(result.current.pending).toBe(false);
  });

  it('holds the old value while pending and settles after the delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    expect(result.current.value).toBe('a');
    expect(result.current.pending).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(result.current.value).toBe('ab');
    expect(result.current.pending).toBe(false);
  });

  it('only settles once for a burst of changes', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: '' },
    });
    for (const v of ['a', 'ab', 'abc']) {
      rerender({ v });
      act(() => vi.advanceTimersByTime(100));
    }
    expect(result.current.value).toBe('');

    act(() => vi.advanceTimersByTime(200));
    expect(result.current.value).toBe('abc');
  });

  it('flush applies a value immediately and cancels the pending timer', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), {
      initialProps: { v: 'a' },
    });
    rerender({ v: 'ab' });
    act(() => result.current.flush('ab'));
    expect(result.current.value).toBe('ab');
    expect(result.current.pending).toBe(false);

    act(() => vi.advanceTimersByTime(200));
    expect(result.current.value).toBe('ab');
  });
});
