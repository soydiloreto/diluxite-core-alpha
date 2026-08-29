import { describe, it, expect } from 'vitest';
import {
  LexicalReranker,
  queryTerms,
  rerankFeatures,
  rerankScore,
  RERANK_WEIGHTS,
} from './reranker';

const rank = async (query: string, docs: { id: string; text: string; title?: string }[]) =>
  (await new LexicalReranker().rerank(query, docs)).map((s) => s.id);

describe('queryTerms', () => {
  it('lower-cases, splits on non-letters and de-duplicates', () => {
    expect(queryTerms('MRR del MRR, ¿neto?')).toEqual(['mrr', 'del', 'neto']);
  });

  it('drops single characters as noise', () => {
    expect(queryTerms('a la b')).toEqual(['la']);
  });

  it('keeps accents and non-latin scripts intact', () => {
    expect(queryTerms('métricas 指标')).toEqual(['métricas', '指标']);
  });
});

describe('rerankFeatures — every signal is countable on its own', () => {
  const at = (text: string, title?: string) =>
    rerankFeatures('cloud de microsoft', { id: 'x', text, title }, 0, 1);

  it('flags a verbatim phrase', () => {
    expect(at('el cloud de microsoft es azure').phrase).toBe(1);
    expect(at('microsoft tiene un cloud').phrase).toBe(0);
  });

  it('measures how much of the query the text covers', () => {
    expect(at('cloud de microsoft').coverage).toBe(1);
    expect(at('cloud solamente').coverage).toBeCloseTo(1 / 3, 5);
    expect(at('nada que ver').coverage).toBe(0);
  });

  it('credits a match in the title separately from the body', () => {
    const withTitle = at('texto irrelevante', 'cloud de microsoft');
    expect(withTitle.title).toBe(1);
    expect(at('texto irrelevante').title).toBe(0);
  });

  it('rewards a match that appears early over one buried at the end', () => {
    const early = at('cloud al principio. ' + 'relleno. '.repeat(50));
    const late = at('relleno. '.repeat(50) + 'cloud al final.');
    expect(early.earliness).toBeGreaterThan(late.earliness);
  });

  it('turns the fused position into a prior, first place highest', () => {
    expect(rerankFeatures('x', { id: 'a', text: '' }, 0, 4).priorRank).toBe(1);
    expect(rerankFeatures('x', { id: 'a', text: '' }, 3, 4).priorRank).toBeCloseTo(0.25, 5);
  });

  /**
   * The substring trap, closed. With `includes`, the query term "de" matched
   * inside "vende" and every Spanish document scored as covering it — which
   * silently flattens the one feature meant to say whether the words are
   * actually there. Same failure the fact lane had to close.
   */
  it('counts whole words, so "de" does not match inside "vende"', () => {
    const f = rerankFeatures('de microsoft', { id: 'x', text: 'vende cosas' }, 0, 1);
    expect(f.coverage).toBe(0);
  });

  it('a token surrounded by punctuation still counts', () => {
    const f = rerankFeatures('churn', { id: 'x', text: '¿el churn? sí.' }, 0, 1);
    expect(f.coverage).toBe(1);
  });
});

describe('LexicalReranker', () => {
  it('promotes an exact phrase over a document that merely shares words', () => {
    const order = rank('cloud de microsoft', [
      { id: 'scattered', text: 'microsoft vende cosas. también hay un cloud por ahí.' },
      { id: 'phrase', text: 'el cloud de microsoft se llama Azure.' },
    ]);
    return expect(order).resolves.toEqual(['phrase', 'scattered']);
  });

  it('promotes full coverage over a partial match', async () => {
    expect(
      await rank('pgvector búsqueda híbrida', [
        { id: 'partial', text: 'usamos pgvector para todo' },
        { id: 'full', text: 'la búsqueda híbrida combina pgvector con BM25' },
      ]),
    ).toEqual(['full', 'partial']);
  });

  it('counts a title match', async () => {
    expect(
      await rank('churn', [
        { id: 'body', text: 'hablamos de bajas y de retención en general' },
        { id: 'titled', title: 'Churn del trimestre', text: 'bajas y retención en general' },
      ]),
    ).toEqual(['titled', 'body']);
  });

  /**
   * The reranker adjusts the fused order, it does not replace it. RRF already
   * combined two channels; a second pass that overpowers that is searching
   * again with worse tools.
   */
  it('keeps the fused order when nothing distinguishes the documents', async () => {
    const docs = [
      { id: 'first', text: 'texto sin relación alguna' },
      { id: 'second', text: 'texto sin relación alguna' },
      { id: 'third', text: 'texto sin relación alguna' },
    ];
    expect(await rank('consulta que no aparece', docs)).toEqual(['first', 'second', 'third']);
  });

  it('is deterministic on ties rather than dependent on sort stability', async () => {
    const docs = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, text: 'idéntico' }));
    const a = await rank('nada', docs);
    const b = await rank('nada', docs);
    expect(a).toEqual(b);
    expect(a).toEqual(docs.map((d) => d.id));
  });

  it('honours topK', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, text: 'x' }));
    expect(await new LexicalReranker().rerank('x', docs, 2)).toHaveLength(2);
  });

  it('handles an empty input and an empty query without throwing', async () => {
    expect(await new LexicalReranker().rerank('q', [])).toEqual([]);
    expect(await rank('', [{ id: 'a', text: 'algo' }])).toEqual(['a']);
  });

  it('cannot be beaten by prior alone: a real match outranks a better-placed miss', async () => {
    // The document RRF put first says nothing about the query; the one it put
    // last contains it verbatim in the title. The second should win.
    expect(
      await rank('churn del trimestre', [
        { id: 'fused-first', text: 'una nota cualquiera sobre otra cosa' },
        { id: 'real-match', title: 'Churn del trimestre', text: 'churn del trimestre: 3%' },
      ]),
    ).toEqual(['real-match', 'fused-first']);
  });
});

describe('rerankScore', () => {
  it('is the weighted sum of its parts, and the weights are stated', () => {
    const f = { phrase: 1, coverage: 1, title: 1, earliness: 1, priorRank: 1 };
    expect(rerankScore(f)).toBeCloseTo(
      RERANK_WEIGHTS.phrase +
        RERANK_WEIGHTS.coverage +
        RERANK_WEIGHTS.title +
        RERANK_WEIGHTS.earliness +
        RERANK_WEIGHTS.prior,
      6,
    );
  });
});
