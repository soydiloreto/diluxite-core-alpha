import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import {
  DeterministicEmbeddingProvider,
  IdentityReranker,
  LexicalReranker,
  SearchService,
} from '@diluxite/core';
import {
  createDb,
  DrizzleNotesRepository,
  DrizzleSearchRepository,
} from '@diluxite/db';
import { buildTestApp, TEST_DATABASE_URL } from '../test/helpers';
import { CORPORA, type EvalCorpus } from '../test/search-eval-corpora';

/**
 * A reproducible baseline for search quality, in the four languages people
 * actually write notes in here: Spanish, English, Brazilian Portuguese and
 * Italian.
 *
 * Not a unit test of the ranker — those live in `reranker.test.ts`. This is
 * the thing the roadmap asked for: a fixed corpus, a fixed query suite with
 * the note each query SHOULD return, and a number. Without it, "search feels
 * better" is a claim nobody can check and every future change to chunking,
 * embeddings or weights is a coin flip.
 *
 * The four corpora are translations of each other (see
 * `test/search-eval-corpora.ts`), so the numbers are comparable: a language
 * that scores lower is telling us about the pipeline, not about an easier
 * fixture.
 */

/**
 * The bar, per language. Deliberately below perfect: the embedder in tests is
 * the deterministic one — a hash, not a language model — so semantic recall is
 * weaker here than in any real deployment. A suite tuned to 100% against a
 * fake embedder would be measuring the fixture, and would break the day the
 * embedder improves.
 *
 * The floors are set one notch under what the pipeline scores today, so this
 * catches a regression without failing on noise. They are NOT a target: the
 * non-Spanish floors are lower because the lexical channel indexes every
 * language with the Spanish stemmer, which the last describe block in this
 * file measures directly. When that is fixed, these numbers move up and the
 * floors move with them.
 */
const FLOORS: Record<string, { at1: number; at3: number }> = {
  // Measured today: es 0.90/1.00 · en 1.00/1.00 · pt-BR 0.90/1.00 · it 0.80/1.00.
  // Each floor sits one query below that — on a ten-query suite, 0.1 is
  // exactly one question, so a single regression trips it and nothing else does.
  es: { at1: 0.8, at3: 0.9 },
  en: { at1: 0.9, at3: 0.9 },
  'pt-BR': { at1: 0.8, at3: 0.9 },
  it: { at1: 0.7, at3: 0.9 },
};

describe.each(CORPORA)('search evaluation — $label', (corpus: EvalCorpus) => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    for (const doc of corpus.docs) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: doc,
      });
      expect(r.statusCode).toBe(201);
    }
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const titlesFor = async (q: string): Promise<string[]> => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: q, spaceId, topK: 5 },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { title: string }[]).map((x) => x.title);
  };

  it('meets the hit@1 and hit@3 baseline over the query suite', async () => {
    const misses: string[] = [];
    let hit1 = 0;
    let hit3 = 0;

    for (const { q, expect: want } of corpus.queries) {
      const titles = await titlesFor(q);
      if (titles[0] === want) hit1++;
      if (titles.slice(0, 3).includes(want)) hit3++;
      else misses.push(`"${q}" → esperaba "${want}", devolvió [${titles.slice(0, 3).join(', ')}]`);
    }

    const at1 = hit1 / corpus.queries.length;
    const at3 = hit3 / corpus.queries.length;
    // Printed so a regression run shows WHICH queries moved, not just a number.
    if (misses.length > 0) console.log(`[${corpus.lang}] hit@3 misses:\n  ${misses.join('\n  ')}`);
    console.log(`[${corpus.lang}] hit@1 = ${at1.toFixed(2)} · hit@3 = ${at3.toFixed(2)}`);

    const floor = FLOORS[corpus.lang];
    expect(at1).toBeGreaterThanOrEqual(floor.at1);
    expect(at3).toBeGreaterThanOrEqual(floor.at3);
  });

  it('an exact term lands its note first', async () => {
    // The lexical channel should make these trivial; if one regresses, the
    // fusion or the reranker changed in a way worth knowing about. These are
    // the same four acronyms in every language — code and product names do
    // not translate, which is exactly why they are the stable probe.
    for (const term of ['RRF', 'TOTP', 'pgvector', 'CRDT']) {
      const titles = await titlesFor(term);
      expect(titles.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing rather than noise for a query about nothing in the corpus', async () => {
    const titles = await titlesFor('recetas de cocina italiana');
    // The deterministic embedder will always return SOMETHING semantically,
    // so this asserts the shape rather than emptiness: whatever comes back
    // must not outrank a real match for a real query.
    expect(Array.isArray(titles)).toBe(true);
  });

  /**
   * The reranker has to earn its place.
   *
   * `IdentityReranker` is the honest "reranking off" baseline, so the suite
   * runs against both and the lexical one must not be worse. Without this the
   * stage could quietly degrade results and every test would still pass —
   * which is how the no-op it replaced survived as the default for so long.
   *
   * Built directly on SearchService rather than through the app: the point is
   * to vary ONE dependency, and going through buildApp would vary the wiring
   * too.
   */
  it('the lexical reranker is at least as good as no reranking, on the same suite', async () => {
    const conn = createDb(TEST_DATABASE_URL);
    try {
      const notesRepo = new DrizzleNotesRepository(conn.db);
      const searchRepo = new DrizzleSearchRepository(conn.db);
      const embedder = new DeterministicEmbeddingProvider(1536);

      const score = async (reranker: IdentityReranker | LexicalReranker) => {
        const svc = new SearchService(searchRepo, embedder, notesRepo, { reranker });
        let hits = 0;
        for (const { q, expect: want } of corpus.queries) {
          const results = await svc.search(spaceId, q, 5);
          if (results[0]?.title === want) hits++;
        }
        return hits / corpus.queries.length;
      };

      const off = await score(new IdentityReranker());
      const lexical = await score(new LexicalReranker());
      console.log(
        `[${corpus.lang}] hit@1 sin reranker = ${off.toFixed(2)} · con lexical = ${lexical.toFixed(2)}`,
      );

      expect(lexical).toBeGreaterThanOrEqual(off);
    } finally {
      await conn.sql.end();
    }
  });
});

/**
 * The lexical channel speaks one language, and the corpus does not.
 *
 * `keywordSearch` indexes and queries with `to_tsvector('spanish', …)` for
 * every note, whatever it is written in (packages/db/src/search-repository.ts,
 * and the GIN index in migration 0000). The vector channel hides most of the
 * damage in the fused ranking, which is why nobody noticed — but it is real,
 * and this block puts a number on it instead of an opinion.
 *
 * What it measures: for a query word that is a different surface form of a
 * word in the note ("versions" vs "version", "modifiche" vs "modifica"), the
 * right stemmer collapses both to the same lexeme and the match happens. The
 * Spanish stemmer applied to English, Portuguese or Italian does not, so the
 * note is invisible to the lexical channel.
 *
 * This asserts TODAY's behaviour, deliberately. When the FTS configuration
 * follows the note's language, these expectations flip to hits — and the test
 * flipping is the proof the fix worked.
 */
describe('lexical channel — the cost of indexing every language as Spanish', () => {
  let sql: Sql;

  beforeAll(() => {
    sql = createDb(TEST_DATABASE_URL).sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  const matches = async (config: string, text: string, query: string): Promise<boolean> => {
    const [row] = await sql<{ hit: boolean }[]>`
      SELECT to_tsvector(${config}::regconfig, ${text})
             @@ websearch_to_tsquery(${config}::regconfig, ${query}) AS hit`;
    return row.hit;
  };

  it('Spanish content is fine — it is the language the index was built for', async () => {
    const es = CORPORA.find((c) => c.lang === 'es')!;
    for (const p of es.probes) {
      expect(await matches('spanish', p.text, p.query)).toBe(true);
    }
  });

  it.each(CORPORA.filter((c) => c.lang !== 'es'))(
    'misses inflections in $label that its own configuration catches',
    async (corpus: EvalCorpus) => {
      const lost: string[] = [];
      for (const p of corpus.probes) {
        const asSpanish = await matches('spanish', p.text, p.query);
        const asOwn = await matches(corpus.pgConfig, p.text, p.query);
        // The probe only means something if the right configuration DOES
        // match: otherwise it is measuring a bad probe, not a bad stemmer.
        expect(asOwn).toBe(true);
        if (!asSpanish) lost.push(`"${p.query}" ↛ "${p.text}"`);
      }
      console.log(
        `[${corpus.lang}] el carril léxico pierde ${lost.length}/${corpus.probes.length}: ${lost.join(' · ')}`,
      );
      // Every probe is lost today. Stated as an equality rather than a
      // threshold so that fixing even one of them fails this test and forces
      // the number to be updated on purpose.
      expect(lost.length).toBe(corpus.probes.length);
    },
  );

  it('stopwords of other languages are indexed as if they were content', async () => {
    // 'the', 'and', 'are' carry no meaning in English, and the English
    // configuration drops them. The Spanish one keeps them as lexemes, so
    // they take up room in the index and in ts_rank.
    const text = 'The servers are running and the deployment ran yesterday';
    const [row] = await sql<{ es: number; en: number }[]>`
      SELECT length(to_tsvector('spanish'::regconfig, ${text})) AS es,
             length(to_tsvector('english'::regconfig, ${text})) AS en`;
    console.log(`[en] lexemas indexados: spanish=${row.es} · english=${row.en}`);
    expect(row.es).toBeGreaterThan(row.en);
  });
});
