/**
 * Meaning collisions — "Company Brain — modo funcional" §9, third defence.
 *
 * The expensive failure is not a disagreement everybody knows about. It is two
 * areas using the SAME WORD for two different things without knowing, and then
 * two reports that do not reconcile. Nobody is wrong; the word is doing two
 * jobs.
 *
 * The check: a key that two notes both state, in notes that are far apart in
 * meaning. If they were about the same thing, they would be near each other —
 * that is what the semantic space is for. Caught where correcting costs
 * minutes instead of meetings.
 *
 * Everything here is arithmetic over a distance the database computed. No
 * model is asked to judge whether two things "mean the same".
 */

/** A key stated in two notes that do not seem to be about the same thing. */
export interface MeaningCollision {
  key: string;
  a: { noteId: string; title: string; value: string; line: number };
  b: { noteId: string; title: string; value: string; line: number };
  /** Cosine distance between the notes. Higher = further apart. */
  distance: number;
  /** True when the two also state different values for the key. */
  valuesDiffer: boolean;
}

/**
 * How far apart two notes must be before sharing a key is suspicious.
 *
 * Cosine distance, so 0 is identical and 1 is unrelated. Deliberately high:
 * a false alarm here sends somebody to read two notes for nothing, and a
 * check that cries wolf is one people switch off — which costs exactly the
 * collisions it was meant to catch.
 */
export const COLLISION_DISTANCE = 0.55;

/**
 * Should this pair be reported?
 *
 * Two notes stating the same key with the SAME value are agreeing, however far
 * apart they read — that is a corroboration, not a collision. It takes both
 * distance and a difference to be worth somebody's attention.
 */
export function isCollision(
  distance: number | null,
  valueA: string,
  valueB: string,
  threshold = COLLISION_DISTANCE,
): boolean {
  if (distance === null) return false;
  if (distance < threshold) return false;
  return valueA.trim().toLowerCase() !== valueB.trim().toLowerCase();
}
