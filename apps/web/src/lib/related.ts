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
/** Max suggestions shown at once. */
export const RELATED_CAP = 5;

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
 * Keep only relevant, non-dismissed suggestions, best-first, capped.
 * Returns the visible set plus how many eligible ones were trimmed by the cap.
 */
export function filterRelated<T extends RelatedItem>(
  items: T[],
  opts: { dismissed?: Set<string>; minRelevance?: number; cap?: number } = {},
): { shown: T[]; hidden: number } {
  const min = opts.minRelevance ?? RELATED_MIN_RELEVANCE;
  const cap = opts.cap ?? RELATED_CAP;
  const dismissed = opts.dismissed ?? new Set<string>();
  const eligible = items
    .filter((r) => !dismissed.has(r.id) && relevanceFromDistance(r.distance) >= min)
    .sort((a, b) => a.distance - b.distance);
  return { shown: eligible.slice(0, cap), hidden: Math.max(0, eligible.length - cap) };
}
