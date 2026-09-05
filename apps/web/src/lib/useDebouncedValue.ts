import { useCallback, useEffect, useRef, useState } from 'react';

export interface Debounced<T> {
  value: T;
  pending: boolean;
  flush: (next: T) => void;
}

export function useDebouncedValue<T>(value: T, delayMs: number): Debounced<T> {
  const [settled, setSettled] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (Object.is(value, settled)) return;
    timer.current = setTimeout(() => setSettled(value), delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [value, settled, delayMs]);

  const flush = useCallback((next: T) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setSettled(next);
  }, []);

  return { value: settled, pending: !Object.is(value, settled), flush };
}
