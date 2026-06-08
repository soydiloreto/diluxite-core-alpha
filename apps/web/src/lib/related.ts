/**
 * Suggested (semantically related) notes — relevance gating.
 *
 * The backend returns the closest notes by cosine distance, but "closest"
 * always fills the limit even when nothing is genuinely related. To keep the
 * graph coherent (instead of "everything links to everything"), we only surface
 * suggestions above a relevance threshold, cap the count, and drop the ones the
 * user dismissed. The rest are reported as a "weaker hidden" count so the panel
 * never looks broken.
 */

/** Minimum relevance (0..1) for a suggestion to show. Tunable. */
export const RELATED_MIN_RELEVANCE = 0.62;

/** Cosine distance (0 = identical, 2 = opposite) → relevance in 0..1. */
export function relevanceFromDistance(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

export interface RelatedItem {
  id: string;
  title: string;
  distance: number;
}

/**
 * Split suggestions into the ones worth showing (relevance ≥ threshold,
 * non-dismissed, best-first) and a count of the rest that fell below the
 * relevance bar. No cap — the backend already limits the fetch, and the
 * tab badge should match exactly what's in the list.
 */
export function filterRelated<T extends RelatedItem>(
  items: T[],
  opts: { dismissed?: Set<string>; minRelevance?: number } = {},
): { shown: T[]; weak: number } {
  const min = opts.minRelevance ?? RELATED_MIN_RELEVANCE;
  const dismissed = opts.dismissed ?? new Set<string>();
  const eligible = items.filter((r) => !dismissed.has(r.id));
  const shown = eligible
    .filter((r) => relevanceFromDistance(r.distance) >= min)
    .sort((a, b) => a.distance - b.distance);
  return { shown, weak: eligible.length - shown.length };
}
