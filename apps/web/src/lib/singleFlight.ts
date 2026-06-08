/**
 * Single-flight: coalesce concurrent calls that share a key so the work runs
 * exactly once. Rapid repeats while the first is in flight get the SAME promise
 * (and thus the same result) instead of each kicking off their own.
 *
 * Used to stop a double-clicked "create missing note" from spawning duplicate
 * empty notes — the second click races the optimistic state update, so a
 * by-title guard at the call site isn't enough; we dedupe the in-flight work.
 */
export function makeSingleFlight<T>() {
  const inflight = new Map<string, Promise<T>>();
  return (key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}
