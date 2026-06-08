/**
 * Per-note "don't suggest this again" memory, persisted in localStorage.
 * Keyed by the source note id → set of dismissed target note ids.
 */
const KEY = 'diluxite.dismissedRelated';

function load(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Target note ids the user dismissed as suggestions for `sourceId`. */
export function getDismissed(sourceId: string): Set<string> {
  return new Set(load()[sourceId] ?? []);
}

/** Remember that `targetId` should no longer be suggested for `sourceId`. */
export function dismissRelated(sourceId: string, targetId: string): void {
  const all = load();
  const set = new Set(all[sourceId] ?? []);
  set.add(targetId);
  all[sourceId] = [...set];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* localStorage unavailable — dismissal stays in memory for this session. */
  }
}
