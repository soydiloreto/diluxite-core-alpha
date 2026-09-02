import {
  assessStaleness,
  budgetFromMinutes,
  selectBatch,
  structuralKindOf,
} from '@diluxite/core';
import type { AppDeps } from './app';

export interface BuiltBatch {
  built: number;
  budget: number;
  medianSecondsPerDecision: number | null;
  /** Whether a generation provider wrote the questions (ADR-006). */
  drafted: boolean;
}

/** Fifteen minutes a week is the design's budget; a caller may say otherwise. */
export const DEFAULT_BUDGET_MINUTES = 15;

/**
 * Build one space's weekly batch.
 *
 * Lives here rather than inside the route because two callers need exactly the
 * same behaviour: the button in the Review screen, and the scheduler that runs
 * once a week so the batch is ready whether or not anybody pressed anything.
 * Two copies of this would drift, and the one that drifts is always the one
 * nobody watches.
 */
export async function buildCurationBatch(
  deps: AppDeps,
  spaceId: string,
  budgetMinutes = DEFAULT_BUDGET_MINUTES,
): Promise<BuiltBatch | null> {
  if (!deps.curation) return null;

  // The divisor is MEASURED, never estimated — see the repository. Nothing can
  // measure a person's minutes, so the budget is expressed in decisions.
  const median = await deps.curation.medianSecondsPerDecision(spaceId);
  const budget = budgetFromMinutes(budgetMinutes, median);

  const candidates = await deps.curation.candidatesFor(spaceId);
  const cadences = deps.provenance
    ? await deps.provenance.cadenceForNotes(candidates.map((c) => c.noteId))
    : new Map();

  const scored = await Promise.all(
    candidates.map(async (c) => {
      const cadence = cadences.get(c.noteId);
      const note = cadence ? await deps.notes.get(c.noteId) : null;
      return {
        ...c,
        staleness:
          cadence && note
            ? assessStaleness(cadence, structuralKindOf(note.contentMd)).level
            : undefined,
        isFact: false,
      };
    }),
  );
  const batch = selectBatch(scored, budget);

  // The one place a generative model touches this product (ADR-006): turning a
  // passage into a claim an owner can answer with yes or no. With no provider
  // every card is still asked — it quotes the note instead of summarising it,
  // which is honest rather than absent. That is why "off" is a working state.
  const space = await deps.spaces.findById(spaceId);
  const drafter = space && deps.drafterFor ? await deps.drafterFor(space.orgId) : null;

  const cards = await Promise.all(
    batch.map(async (c) => {
      const fallback = { ...c, question: 'Does this still hold?', citation: c.title };
      if (!drafter) return fallback;
      try {
        const note = await deps.notes.get(c.noteId);
        const drafted = note ? await drafter.draftClaim(note.title, note.contentMd) : null;
        // A passage that states nothing confirmable produces no card at all: a
        // person's fifteen seconds on a question with no answer is worse than
        // one candidate fewer.
        return drafted ? { ...c, question: 'Does this still hold?', citation: drafted.claim } : null;
      } catch {
        // A drafting failure costs a better sentence, never the card.
        return fallback;
      }
    }),
  );

  const built = await deps.curation.buildBatch(
    spaceId,
    cards.filter((c): c is NonNullable<typeof c> => c !== null),
  );
  return { built, budget, medianSecondsPerDecision: median, drafted: !!drafter };
}
