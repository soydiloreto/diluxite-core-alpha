/**
 * The curation queue — what an owner is asked to confirm this week.
 *
 * From "Company Brain — modo funcional" §8, and it is the half ADR-002 left
 * out. The model there graded everything on one ladder (N0 inferred → N3
 * verified → Core), which ADR-002 rejected as a single number. The RITUAL was
 * never rejected: its levels are a reading of rank plus provenance, and what
 * was missing is everything that produces those values.
 *
 * Everything in this file is arithmetic over counts and dates. A model may
 * draft the wording of a question (ADR-006); nothing here consults one, and
 * nothing here decides whether something is true.
 */

import type { Fact } from './facts';

/** A note the queue is considering, in the terms the ordering uses. */
export interface CurationCandidate {
  noteId: string;
  title: string;
  /** How often it was used to answer (migration 0038). Zero = never returned. */
  useCount: number;
  /** Seconds since anybody signed it. Null = nobody ever has. */
  secondsSinceConfirmed: number | null;
  /** Its own measured verdict, when the deployment measures cadence. */
  staleness?: 'fresh' | 'aging' | 'stale';
  /** True when the claim is an exact value derived from a table. */
  isFact: boolean;
}

/** A candidate with the number that decides whether it fits in the batch. */
export interface ScoredCandidate extends CurationCandidate {
  score: number;
}

/**
 * How long an unconfirmed claim has to sit before its uncertainty is full.
 *
 * Ninety days rather than a shorter window because confirming is a person's
 * time: asking again about something signed last month spends the budget on
 * reassurance.
 */
export const CONFIRMATION_HALF_LIFE_DAYS = 90;

/**
 * Expected value of asking about this, from the three terms the design names:
 * how often it is used × how unsure we are × what breaks if it is wrong.
 *
 * Multiplied, not added, and that is the point: something used constantly but
 * signed yesterday is not worth a question, and neither is something nobody
 * has ever read no matter how unverified it is. A sum would rank both above a
 * claim that is merely moderate in both.
 *
 * `log1p` on the count so the most-read note does not own the whole batch —
 * the tenth use tells you much less than the first.
 */
export function scoreCandidate(c: CurationCandidate): number {
  const usage = Math.log1p(Math.max(0, c.useCount));
  if (usage === 0) return 0;

  const uncertainty =
    c.secondsSinceConfirmed === null
      ? 1
      : Math.min(1, c.secondsSinceConfirmed / (CONFIRMATION_HALF_LIFE_DAYS * 86_400));

  // What breaks if it is wrong. A fact is quoted as an exact answer, above the
  // prose and labelled as certain, so a wrong one is believed — the governing
  // asymmetry the fact lane is already built around. Being past its own rhythm
  // is evidence the world moved, not merely that time passed.
  const blast = (c.isFact ? 1.5 : 1) * (c.staleness === 'stale' ? 1.5 : c.staleness === 'aging' ? 1.2 : 1);

  return usage * uncertainty * blast;
}

/**
 * How many items fit in the budget.
 *
 * "Fifteen minutes a week" is not implementable — nothing can measure a
 * person's minutes. Decisions can be measured, so the budget is expressed in
 * them and the divisor is the MEASURED median time per decision, not an
 * estimate. If decisions get slower, fewer are proposed, with nobody adjusting
 * anything.
 *
 * The floor exists because a fresh installation has measured nothing yet: it
 * proposes a small batch, learns the real number from it, and grows into the
 * budget rather than guessing high and burning the owner's first week.
 */
export const COLD_START_BATCH = 10;

export function budgetFromMinutes(minutes: number, medianSecondsPerDecision: number | null): number {
  if (!medianSecondsPerDecision || medianSecondsPerDecision <= 0) return COLD_START_BATCH;
  return Math.max(1, Math.floor((minutes * 60) / medianSecondsPerDecision));
}

/**
 * The batch: the best `budget` candidates, and nothing else.
 *
 * What does not fit is NOT queued for next week. It stays in the notes,
 * uncurated and marked as such, and competes again next time if it gets used
 * more. A queue that grows is the failure signal, not evidence of demand —
 * when there are more candidates than budget the bar rises, never the load.
 */
export function selectBatch(candidates: CurationCandidate[], budget: number): ScoredCandidate[] {
  return candidates
    .map((c) => ({ ...c, score: scoreCandidate(c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId))
    .slice(0, Math.max(0, budget));
}

/**
 * The question for an exact value, from a template.
 *
 * No model, no drafting, no provider: a fact already says "for KEY, the COLUMN
 * is VALUE", which is a yes/no question with the words rearranged. This is why
 * the queue works with ADR-006's generation provider switched off — facts keep
 * their questions, and only prose candidates go unproposed.
 */
export function questionForFact(fact: Fact): { question: string; citation: string } {
  return {
    question: `Does this still hold?`,
    citation: `${fact.key} — ${fact.column}: ${fact.value}`,
  };
}

/** What an owner can answer. `reassigned` is "not mine". */
export type CurationDecision = 'confirmed' | 'superseded' | 'rejected' | 'reassigned';
