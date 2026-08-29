import { describe, it, expect } from 'vitest';
import {
  assessStaleness,
  shouldHedge,
  COLD_START_PRIOR_SECONDS,
  HEDGE_AFTER_INTERVALS,
  freshnessNote,
  structuralKindOf,
  type ChangeCadence,
} from './staleness';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-29T12:00:00Z');

const cadence = (opts: Partial<ChangeCadence> & { daysAgo: number }): ChangeCadence => ({
  avgIntervalSeconds: opts.avgIntervalSeconds ?? null,
  changeCount: opts.changeCount ?? 0,
  lastChangedAt: new Date(NOW.getTime() - opts.daysAgo * DAY),
});

describe('assessStaleness — judged in the entity\'s own cadence, not the calendar', () => {
  it('a note touched well within its own rhythm is fresh', () => {
    // Changes about monthly, last touched a week ago.
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 8, daysAgo: 7 }),
      'prose',
      NOW,
    );
    expect(a.level).toBe('fresh');
    expect(shouldHedge(a)).toBe(false);
    expect(a.usingPrior).toBe(false);
  });

  it('starts hedging once it has missed two of its own cycles', () => {
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 8, daysAgo: 65 }),
      'prose',
      NOW,
    );
    expect(a.level).toBe('aging');
    expect(shouldHedge(a)).toBe(true);
    expect(a.intervalsElapsed).toBeGreaterThanOrEqual(HEDGE_AFTER_INTERVALS);
  });

  it('stops presenting it as current after many missed cycles', () => {
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 8, daysAgo: 200 }),
      'prose',
      NOW,
    );
    expect(a.level).toBe('stale');
  });

  /**
   * The reason the threshold is relative. A fixed "older than 90 days" flags
   * the architecture note that has been correct for a year and clears the
   * metrics table that went stale last week — exactly backwards, and the two
   * cases below are the same number of days old.
   */
  it('judges two notes of identical age differently, on their own rhythms', () => {
    const daysAgo = 60;
    const slowNote = assessStaleness(
      cadence({ avgIntervalSeconds: 365 * 86_400, changeCount: 5, daysAgo }),
      'prose',
      NOW,
    );
    const fastNote = assessStaleness(
      cadence({ avgIntervalSeconds: 7 * 86_400, changeCount: 20, daysAgo }),
      'structured',
      NOW,
    );

    expect(slowNote.ageSeconds).toBe(fastNote.ageSeconds);
    expect(slowNote.level).toBe('fresh');
    expect(fastNote.level).toBe('stale');
  });

  describe('cold start', () => {
    it('uses the structural prior when there is no interval to have measured', () => {
      const a = assessStaleness(cadence({ changeCount: 1, daysAgo: 10 }), 'prose', NOW);
      expect(a.usingPrior).toBe(true);
      expect(a.expectedIntervalSeconds).toBe(COLD_START_PRIOR_SECONDS.prose);
    });

    // One observation is a point, not a gap. Trusting an average computed from
    // a single change would be dressing a guess as evidence.
    it('treats a single change as no evidence, even if an average is present', () => {
      const a = assessStaleness(
        cadence({ avgIntervalSeconds: 3600, changeCount: 1, daysAgo: 1 }),
        'prose',
        NOW,
      );
      expect(a.usingPrior).toBe(true);
      expect(a.expectedIntervalSeconds).toBe(COLD_START_PRIOR_SECONDS.prose);
    });

    it('the prior keys off structure, and structured content is expected to last far longer', () => {
      const daysAgo = 100;
      const prose = assessStaleness(cadence({ daysAgo }), 'prose', NOW);
      const structured = assessStaleness(cadence({ daysAgo }), 'structured', NOW);
      expect(prose.level).toBe('aging');
      expect(structured.level).toBe('fresh');
      // The measured spread the priors come from is ~80x.
      expect(
        COLD_START_PRIOR_SECONDS.structured / COLD_START_PRIOR_SECONDS.prose,
      ).toBeGreaterThan(50);
    });

    it('evidence replaces the prior as soon as there is any', () => {
      const withPrior = assessStaleness(cadence({ changeCount: 1, daysAgo: 100 }), 'prose', NOW);
      const withEvidence = assessStaleness(
        cadence({ avgIntervalSeconds: 7 * 86_400, changeCount: 4, daysAgo: 100 }),
        'prose',
        NOW,
      );
      expect(withPrior.usingPrior).toBe(true);
      expect(withEvidence.usingPrior).toBe(false);
      // Same age, and the measured cadence is what changes the verdict.
      expect(withPrior.level).toBe('aging');
      expect(withEvidence.level).toBe('stale');
    });
  });

  it('a note changed moments ago is fresh at any cadence', () => {
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 3600, changeCount: 50, daysAgo: 0 }),
      'structured',
      NOW,
    );
    expect(a.level).toBe('fresh');
    expect(a.ageSeconds).toBe(0);
  });

  it('never reports a negative age when a clock ran ahead', () => {
    const future: ChangeCadence = {
      avgIntervalSeconds: 3600,
      changeCount: 5,
      lastChangedAt: new Date(NOW.getTime() + 60_000),
    };
    expect(assessStaleness(future, 'prose', NOW).ageSeconds).toBe(0);
  });
});

describe('structuralKindOf — shape, not subject', () => {
  it('calls a note of sentences prose', () => {
    expect(structuralKindOf('# Título\n\nUn párrafo cualquiera.\n\nOtro más.')).toBe('prose');
  });

  it('calls a note that is mostly a table structured', () => {
    const md = `| Métrica | Valor |
| --- | --- |
| MRR | 42k |
| Usuarios | 1200 |`;
    expect(structuralKindOf(md)).toBe('structured');
  });

  it('a table with a paragraph of context around it is still prose', () => {
    // The majority rule matters: a note is "structured" when the table IS the
    // note, not when it happens to contain one.
    const md = `Venimos creciendo desde marzo, sobre todo por el boca a boca,
y el equipo cree que se sostiene un trimestre más.

| Métrica | Valor |
| --- | --- |
| MRR | 42k |

Esto último hay que confirmarlo con finanzas antes del comité.`;
    expect(structuralKindOf(md)).toBe('prose');
  });

  it('an empty note is prose rather than a crash', () => {
    expect(structuralKindOf('')).toBe('prose');
    expect(structuralKindOf('   \n  \n')).toBe('prose');
  });
});

describe('freshnessNote — the sentence a model reads out', () => {
  it('says nothing about something fresh: a caveat on every line is one nobody reads', () => {
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 9, daysAgo: 3 }),
      'prose',
      NOW,
    );
    expect(freshnessNote(a)).toBeNull();
  });

  it('names the measured cadence when there is one', () => {
    const a = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 9, daysAgo: 240 }),
      'prose',
      NOW,
    );
    const note = freshnessNote(a)!;
    expect(note).toContain('240 days ago');
    expect(note).toContain('30-day cadence');
    expect(note).toContain('unconfirmed');
  });

  // The distinction that keeps the sentence honest: "this note usually changes
  // monthly" is evidence; "things shaped like this usually do" is a guess. An
  // answer that blurs them is plausible, unverifiable and trusted.
  it('does not claim a cadence it never measured', () => {
    const a = assessStaleness(cadence({ changeCount: 1, daysAgo: 500 }), 'prose', NOW);
    const note = freshnessNote(a)!;
    expect(a.usingPrior).toBe(true);
    expect(note).toContain('not enough edit history');
    expect(note).not.toMatch(/its usual \d+-day cadence/);
  });

  it('hedges before it refuses: aging warns, stale says unconfirmed', () => {
    const aging = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 9, daysAgo: 70 }),
      'prose',
      NOW,
    );
    const stale = assessStaleness(
      cadence({ avgIntervalSeconds: 30 * 86_400, changeCount: 9, daysAgo: 300 }),
      'prose',
      NOW,
    );
    expect(freshnessNote(aging)).not.toContain('unconfirmed');
    expect(freshnessNote(stale)).toContain('unconfirmed');
  });
});
