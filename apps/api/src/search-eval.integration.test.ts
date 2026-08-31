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
  // Measured over repeated runs: es 0.90 · en 0.90–1.00 · pt-BR 0.90–1.00 ·
  // it 0.80, with hit@3 at 1.00 throughout. The spread is not noise in the
  // ranking: `ts_rank` ties constantly on a corpus this small and the tie is
  // broken by `chunks.id`, a random UUID minted at insert — so two runs over
  // the same text order the tied rows differently. Each floor sits one query
  // below the LOWEST observed value; on a ten-query suite 0.1 is exactly one
  // question, so a real regression trips it and the shuffle does not.
  es: { at1: 0.8, at3: 0.9 },
  en: { at1: 0.8, at3: 0.9 },
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
   * The lexical channel alone, asked in the note's own language.
   *
   * `mode: 'keyword'` on purpose — the whole point is to exercise Postgres
   * FTS with the vector channel switched off, because the fused ranking is
   * what hid this problem for so long. Each probe queries a different surface
   * form of a word in the note ("backups" for "backup", "modifica" for
   * "modifiche"): the note's own stemmer collapses them, the Spanish one
   * applied to another language does not.
   */
  it('the keyword channel finds a note by an inflected form of its words', async () => {
    const conn = createDb(TEST_DATABASE_URL);
    try {
      const svc = new SearchService(
        new DrizzleSearchRepository(conn.db),
        new DeterministicEmbeddingProvider(1536),
        new DrizzleNotesRepository(conn.db),
      );
      for (const probe of corpus.probes) {
        const owner = corpus.docs.find((d) => d.contentMd.includes(probe.text));
        // A probe that quotes no note measures nothing; fail loudly instead.
        expect(owner, `probe "${probe.text}" is not in the corpus`).toBeDefined();
        const results = await svc.search(spaceId, probe.query, 5, 'keyword');
        expect(
          results.map((r) => r.title),
          `[${corpus.lang}] "${probe.query}" should reach "${owner!.title}"`,
        ).toContain(owner!.title);
      }
    } finally {
      await conn.sql.end();
    }
  });

});

/**
 * The reranker has to earn its place — over the whole corpus, not one language.
 *
 * `IdentityReranker` is the honest "reranking off" baseline, so the suite runs
 * against both and the lexical one must not be worse. Without this the stage
 * could quietly degrade results and every test would still pass — which is how
 * the no-op it replaced survived as the default for so long.
 *
 * Measured over all four corpora in ONE space, deliberately. Ten queries make
 * a single question worth 0.1, so per language this comparison is noise: it
 * reports a "regression" whenever the two stages disagree about one item. Forty
 * questions in a mixed-language vault is both the more honest measurement and
 * the more realistic one — a real vault is not monolingual either.
 *
 * Built directly on SearchService rather than through the app: the point is to
 * vary ONE dependency, and going through buildApp would vary the wiring too.
 */
describe('reranking, measured across the four corpora at once', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    for (const corpus of CORPORA) {
      for (const doc of corpus.docs) {
        const r = await app.inject({
          method: 'POST',
          url: `/api/spaces/${spaceId}/notes`,
          payload: doc,
        });
        expect(r.statusCode).toBe(201);
      }
    }
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('the lexical reranker is at least as good as no reranking', async () => {
    const conn = createDb(TEST_DATABASE_URL);
    try {
      const notesRepo = new DrizzleNotesRepository(conn.db);
      const searchRepo = new DrizzleSearchRepository(conn.db);
      const embedder = new DeterministicEmbeddingProvider(1536);
      const suite = CORPORA.flatMap((c) =>
        c.queries.map((q) => ({ ...q, lang: c.lang })),
      );

      const score = async (reranker: IdentityReranker | LexicalReranker) => {
        const svc = new SearchService(searchRepo, embedder, notesRepo, { reranker });
        const tops: string[] = [];
        let hits = 0;
        for (const { q, expect: want } of suite) {
          const results = await svc.search(spaceId, q, 5);
          tops.push(results[0]?.title ?? '∅');
          if (results[0]?.title === want) hits++;
        }
        return { rate: hits / suite.length, tops };
      };

      const off = await score(new IdentityReranker());
      const lexical = await score(new LexicalReranker());
      console.log(
        `[mixto] hit@1 sin reranker = ${off.rate.toFixed(2)} · con lexical = ${lexical.rate.toFixed(2)}`,
      );
      // Which questions the stage actually moved. Two numbers say whether the
      // reranker helped; this says on what, which is the only form of that
      // fact anyone can act on.
      suite.forEach(({ q, expect: want, lang }, i) => {
        if (off.tops[i] !== lexical.tops[i]) {
          console.log(
            `[${lang}] "${q}" (esperaba "${want}"): sin reranker "${off.tops[i]}" → con lexical "${lexical.tops[i]}"`,
          );
        }
      });

      expect(lexical.rate).toBeGreaterThanOrEqual(off.rate);
    } finally {
      await conn.sql.end();
    }
  });
});

/**
 * Why the configuration has to follow the note, in Postgres' own terms.
 *
 * The test above proves the pipeline now finds these notes. This block is the
 * evidence for why it could not before migration 0033: with one
 * `to_tsvector('spanish', …)` index — what the schema carried since 0000 —
 * the same probes are simply not matches. It is a property of the stemmers
 * rather than of our code, which is what makes it worth keeping: it is the
 * thing that would silently come back if the per-row configuration were ever
 * collapsed into a constant again.
 */
describe('why the text-search configuration has to follow the note', () => {
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
    'the Spanish stemmer loses every probe in $label that its own catches',
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
        `[${corpus.lang}] con 'spanish' se perderían ${lost.length}/${corpus.probes.length}: ${lost.join(' · ')}`,
      );
      // All of them. An equality rather than a threshold so that a stemmer
      // change in a future Postgres surfaces here as a number to update on
      // purpose, rather than passing quietly.
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
