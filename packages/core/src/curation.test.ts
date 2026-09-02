import { describe, it, expect } from 'vitest';
import {
  scoreCandidate,
  selectBatch,
  budgetFromMinutes,
  questionForFact,
  COLD_START_BATCH,
  type CurationCandidate,
} from './curation';

const base: CurationCandidate = {
  noteId: 'n1',
  title: 'N',
  useCount: 10,
  secondsSinceConfirmed: null,
  isFact: false,
};

describe('scoreCandidate', () => {
  it('a note nobody ever used is never worth a question', () => {
    // The budget is a person's time. Spending it on something the memory has
    // never leaned on is the failure the ordering exists to prevent.
    expect(scoreCandidate({ ...base, useCount: 0 })).toBe(0);
  });

  it('something signed yesterday scores far below the same thing never signed', () => {
    const never = scoreCandidate(base);
    const fresh = scoreCandidate({ ...base, secondsSinceConfirmed: 86_400 });
    expect(fresh).toBeLessThan(never / 10);
  });

  it('uncertainty saturates: signed two years ago is no worse than never signed', () => {
    const old = scoreCandidate({ ...base, secondsSinceConfirmed: 730 * 86_400 });
    expect(old).toBe(scoreCandidate(base));
  });

  it('the terms multiply, so being unread cannot be offset by being unverified', () => {
    const readOnceUnverified = scoreCandidate({ ...base, useCount: 1 });
    const readOftenJustSigned = scoreCandidate({
      ...base,
      useCount: 500,
      secondsSinceConfirmed: 3600,
    });
    expect(readOftenJustSigned).toBeLessThan(readOnceUnverified);
  });

  it('usage has diminishing returns — the most-read note does not own the batch', () => {
    const ten = scoreCandidate({ ...base, useCount: 10 });
    const hundred = scoreCandidate({ ...base, useCount: 100 });
    expect(hundred).toBeLessThan(ten * 2);
  });

  it('an exact value outranks prose, and being past its rhythm outranks both', () => {
    expect(scoreCandidate({ ...base, isFact: true })).toBeGreaterThan(scoreCandidate(base));
    expect(scoreCandidate({ ...base, staleness: 'stale' })).toBeGreaterThan(
      scoreCandidate({ ...base, staleness: 'aging' }),
    );
  });
});

describe('selectBatch', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    ...base,
    noteId: `n${i}`,
    useCount: i + 1,
  }));

  it('takes only what fits, best first — the bar rises, never the load', () => {
    const batch = selectBatch(many, 45);
    expect(batch).toHaveLength(45);
    expect(batch[0].useCount).toBe(300);
    // What did not fit is simply not proposed. There is no backlog: it
    // competes again next week if it gets used more.
    expect(batch.some((c) => c.useCount === 1)).toBe(false);
  });

  it('drops candidates worth nothing rather than padding the batch', () => {
    const batch = selectBatch([{ ...base, useCount: 0 }], 45);
    expect(batch).toEqual([]);
  });

  it('is deterministic when scores tie', () => {
    const tied = [
      { ...base, noteId: 'b' },
      { ...base, noteId: 'a' },
    ];
    expect(selectBatch(tied, 2).map((c) => c.noteId)).toEqual(['a', 'b']);
  });
});

describe('budgetFromMinutes', () => {
  it('is decisions, not minutes: fifteen minutes at twenty seconds is 45', () => {
    expect(budgetFromMinutes(15, 20)).toBe(45);
  });

  it('a slower decision shrinks the batch with nobody adjusting anything', () => {
    expect(budgetFromMinutes(15, 60)).toBe(15);
  });

  it('having measured nothing yet proposes a small batch instead of guessing', () => {
    expect(budgetFromMinutes(15, null)).toBe(COLD_START_BATCH);
    expect(budgetFromMinutes(15, 0)).toBe(COLD_START_BATCH);
  });

  it('never proposes zero when the budget is real but tiny', () => {
    expect(budgetFromMinutes(1, 120)).toBe(1);
  });
});

describe('questionForFact', () => {
  it('is a template — no model is involved for an exact value', () => {
    const q = questionForFact({
      key: 'umbral_fraude',
      column: 'valor',
      value: '3%',
      line: 14,
      keyColumn: 'parámetro',
    });
    expect(q.citation).toBe('umbral_fraude — valor: 3%');
    expect(q.question).toMatch(/still hold/i);
  });
});
