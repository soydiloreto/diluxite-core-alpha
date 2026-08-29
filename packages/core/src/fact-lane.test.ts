import { describe, it, expect } from 'vitest';
import { matchKeys, rankFactsForQuery, factSentence } from './fact-lane';

describe('matchKeys — the space\'s own keys decide, not a classifier', () => {
  const keys = ['MRR', 'Altas', 'Churn', 'MRR neto', 'AI'];

  it('finds a key the question names', () => {
    expect(matchKeys('cuánto es el MRR este mes', keys).map((m) => m.key)).toEqual(['MRR']);
  });

  it('finds nothing when the question names nothing — which costs one lookup', () => {
    expect(matchKeys('cómo venimos con el producto', keys)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(matchKeys('y el mrr?', keys).map((m) => m.key)).toEqual(['MRR']);
  });

  /**
   * Substring matching is what makes an exact lane produce wrong exact
   * answers, which is the single failure it must not have. `MRR` must not
   * fire on `MRRs`, and `AI` must not fire on the middle of a word.
   */
  it('matches whole tokens, never substrings', () => {
    expect(matchKeys('los MRRs de cada plan', keys)).toEqual([]);
    expect(matchKeys('eso ya lo dije antes', keys)).toEqual([]);
    expect(matchKeys('trabajo en AI, sí', keys).map((m) => m.key)).toEqual(['AI']);
  });

  it('prefers the more specific key when one contains the other', () => {
    // A space with both `MRR` and `MRR neto`: naming the second means the
    // second, and answering both would hand over two conflicting facts.
    expect(matchKeys('cuánto da el MRR neto', keys).map((m) => m.key)).toEqual(['MRR neto']);
  });

  it('finds several distinct keys in one question', () => {
    const found = matchKeys('comparame Altas contra Churn', keys).map((m) => m.key).sort();
    expect(found).toEqual(['Altas', 'Churn']);
  });

  it('matches a key at either end of the question', () => {
    expect(matchKeys('MRR', keys).map((m) => m.key)).toEqual(['MRR']);
    expect(matchKeys('decime el Churn', keys).map((m) => m.key)).toEqual(['Churn']);
  });

  it('survives punctuation around the key', () => {
    expect(matchKeys('¿MRR?', keys).map((m) => m.key)).toEqual(['MRR']);
    expect(matchKeys('altas, churn y nada más', keys).map((m) => m.key).sort()).toEqual([
      'Altas',
      'Churn',
    ]);
  });

  it('ignores an empty key rather than matching everything', () => {
    expect(matchKeys('cualquier cosa', ['', '  '])).toEqual([]);
  });
});

describe('rankFactsForQuery', () => {
  const hits = [
    { columnName: 'Valor', value: '42k' },
    { columnName: 'Dueño', value: 'Ana' },
    { columnName: 'Meta', value: '50k' },
  ];

  it('narrows to the column the question names', () => {
    expect(rankFactsForQuery('quién es el dueño del MRR', hits)).toEqual([
      { columnName: 'Dueño', value: 'Ana' },
    ]);
  });

  // Handing over the whole row beats guessing which cell was meant: the reader
  // can see all of it, and nothing was silently dropped.
  it('returns every column when the question names none', () => {
    expect(rankFactsForQuery('MRR', hits)).toHaveLength(3);
  });

  it('can return more than one column when the question names more than one', () => {
    const out = rankFactsForQuery('valor y meta del MRR', hits);
    expect(out.map((h) => h.columnName)).toEqual(['Valor', 'Meta']);
  });
});

describe('factSentence', () => {
  it('reads as something an answer can quote', () => {
    expect(
      factSentence({ key: 'MRR', keyColumn: 'Métrica', columnName: 'Valor', value: '42k' }),
    ).toBe('MRR · Valor: 42k');
  });
});
