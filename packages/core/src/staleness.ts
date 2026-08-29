/**
 * How old is this, and should the answer hedge? — ADR-002, the decay half.
 *
 * Everything here is arithmetic over timestamps. No model, and that is a
 * design constraint rather than an omission: the system has to be able to
 * answer *"why do you say this is stale?"* with **"you changed this note six
 * times in six months and have not touched it in four"** — a count, which is
 * checkable, rather than a judgement, which is not.
 *
 * The estimate of how fast something goes stale is its own measured cadence
 * (`entity_change_stats`), not a category anybody declared. Where there is no
 * cadence yet, a prior stands in — and the prior keys off STRUCTURE rather
 * than topic, because that is what the evidence says predicts shelf life. On
 * Wikipedia the median is 46 days for a lead sentence against 3,740 for an
 * infobox field: two orders of magnitude, same corpus, same subjects. Any
 * taxonomy of topics groups those two together and is wrong about both.
 */

const DAY_SECONDS = 24 * 60 * 60;

/**
 * What kind of thing this is, structurally — the only input to the cold-start
 * prior. Not a knowledge class and not a topic: it says how the content is
 * SHAPED, which is the property that predicts change.
 */
export type StructuralKind = 'prose' | 'structured';

/**
 * Cold-start priors, in seconds, taken from the Wikipedia measurement and
 * rounded to something defensible rather than precise.
 *
 * They exist only until an entity has two changes of its own to measure
 * between, at which point evidence replaces the guess. Being roughly right in
 * the first weeks matters much less than not being permanently wrong, which is
 * what a declared category would have been.
 */
export const COLD_START_PRIOR_SECONDS: Record<StructuralKind, number> = {
  prose: 46 * DAY_SECONDS,
  structured: 3740 * DAY_SECONDS,
};

/**
 * How many typical intervals may pass before an answer starts hedging.
 *
 * At 1.0 anything a day overdue reads as suspect and the hedge becomes noise
 * people learn to ignore, which is worse than not hedging. At 2.0 the thing
 * has missed two of its own cycles — for a note you touch monthly that is two
 * months of silence, which is a real signal about that note rather than about
 * the calendar. Deliberately expressed in the entity's OWN cadence: a fixed
 * "older than 90 days" would flag a stable architecture note and clear a
 * metrics table that goes stale in a week.
 */
export const HEDGE_AFTER_INTERVALS = 2;

/** Beyond this many of its own intervals, the value stops being presented as current. */
export const SUPERSEDE_SUSPECT_AFTER_INTERVALS = 6;

export interface ChangeCadence {
  /** The entity's measured average gap between changes, or null when unknown. */
  avgIntervalSeconds: number | null;
  lastChangedAt: Date;
  changeCount: number;
}

export type StalenessLevel = 'fresh' | 'aging' | 'stale';

export interface StalenessAssessment {
  level: StalenessLevel;
  /** Seconds since the last change. */
  ageSeconds: number;
  /** The cadence used to judge it — measured, or the structural prior. */
  expectedIntervalSeconds: number;
  /** True when `expectedIntervalSeconds` is a prior rather than evidence. */
  usingPrior: boolean;
  /** Age expressed in the entity's own cycles. 1.0 = exactly one interval overdue. */
  intervalsElapsed: number;
}

/**
 * Judge one entity's freshness.
 *
 * `changeCount < 2` means there is no interval to have measured — one
 * observation is a point, not a gap — so the prior stands in and
 * `usingPrior` says so. A caller that renders this must pass that flag
 * through: "this usually changes monthly" and "things shaped like this
 * usually change monthly" are different claims, and conflating them is the
 * same class of dishonesty as inventing provenance.
 */
export function assessStaleness(
  cadence: ChangeCadence,
  structure: StructuralKind,
  now: Date = new Date(),
): StalenessAssessment {
  const measured =
    cadence.avgIntervalSeconds !== null && cadence.changeCount >= 2
      ? cadence.avgIntervalSeconds
      : null;
  const expected = measured ?? COLD_START_PRIOR_SECONDS[structure];
  const ageSeconds = Math.max(0, (now.getTime() - cadence.lastChangedAt.getTime()) / 1000);
  const intervalsElapsed = expected > 0 ? ageSeconds / expected : 0;

  const level: StalenessLevel =
    intervalsElapsed >= SUPERSEDE_SUSPECT_AFTER_INTERVALS
      ? 'stale'
      : intervalsElapsed >= HEDGE_AFTER_INTERVALS
        ? 'aging'
        : 'fresh';

  return {
    level,
    ageSeconds,
    expectedIntervalSeconds: expected,
    usingPrior: measured === null,
    intervalsElapsed,
  };
}

/**
 * Whether an answer resting on this should hedge rather than assert.
 *
 * Kept separate from the level so the policy is one named thing instead of a
 * comparison repeated at each call site — the moment it is inlined twice, the
 * two copies start disagreeing.
 */
export function shouldHedge(assessment: StalenessAssessment): boolean {
  return assessment.level !== 'fresh';
}

/**
 * Classify content by SHAPE, for the cold-start prior only.
 *
 * Not a knowledge class and not a topic — it answers "is this written, or is
 * it tabulated", which is the property the Wikipedia measurement found
 * predictive. A note that is mostly a table behaves like an infobox field; one
 * that is mostly sentences behaves like a lead sentence.
 *
 * Deliberately crude. It is a starting guess that evidence overwrites after
 * two changes, so precision here buys very little, and a subtle rule would
 * invite the belief that the label means more than it does.
 */
export function structuralKindOf(markdown: string): StructuralKind {
  const lines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 'prose';
  const tableLines = lines.filter((l) => l.startsWith('|') && l.endsWith('|')).length;
  return tableLines > lines.length / 2 ? 'structured' : 'prose';
}

/**
 * A short, plain-English note about how current something is — for the MCP
 * surface, where the reader is a model composing an answer for a person.
 *
 * Returns null when the thing is fresh: silence is the correct output there.
 * A caveat printed on every result is one nobody reads, which costs exactly
 * the cases where the caveat mattered.
 *
 * The wording distinguishes measured cadence from the structural prior. "This
 * usually changes monthly" and "things shaped like this usually change
 * monthly" are different claims, and an answer that blurs them is the same
 * failure as inventing provenance — plausible, unverifiable, and trusted.
 */
export function freshnessNote(assessment: StalenessAssessment): string | null {
  if (assessment.level === 'fresh') return null;
  const days = Math.round(assessment.ageSeconds / DAY_SECONDS);
  const age = days >= 1 ? `last changed ${days} day${days === 1 ? '' : 's'} ago` : 'changed today';
  if (assessment.usingPrior) {
    return assessment.level === 'stale'
      ? `${age}, and there is not enough edit history to say whether that is unusual — treat as unconfirmed`
      : `${age}; no measured cadence for this yet`;
  }
  const cycles = assessment.intervalsElapsed.toFixed(1);
  const typical = Math.round(assessment.expectedIntervalSeconds / DAY_SECONDS);
  return assessment.level === 'stale'
    ? `${age}, about ${cycles}x its usual ${typical}-day cadence — treat as unconfirmed`
    : `${age}, past its usual ${typical}-day cadence`;
}

