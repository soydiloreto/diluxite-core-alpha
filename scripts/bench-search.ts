/**
 * Diluxite — reproducible search benchmark.
 *
 * The performance claims in ADR-003 (98.6 ms against 4.3 ms at 20k vectors,
 * the "23×") were measured once, by hand, on one machine, and written down.
 * That is a number nobody else can check and nobody can re-run after changing
 * chunking, the reranker or an index. This is the harness that turns it into
 * a measurement: a deterministic corpus, a fixed query suite, and a table.
 *
 * It measures what the API actually calls — `SearchService` over
 * `DrizzleSearchRepository` — not hand-written SQL shaped like what the
 * repository is believed to send. A benchmark of a query the product does not
 * run is a benchmark of nothing.
 *
 * The vector lane is measured twice: as shipped, and over a connection that
 * starts with `enable_indexscan=off`, which forces the same query onto a
 * sequential scan. Same rows, same SQL, same process — the ratio between them
 * is what the HNSW index is worth, reproducibly.
 *
 * Measured on the maintainer's machine (WSL2, Postgres 17 + pgvector, 20k
 * vectors): at 1536 dims `vectorSearch` takes 3.4 ms with the index and
 * 124.6 ms without it — 36×, where ADR-003 recorded 4.3 ms against 98.6 ms. At
 * 256 dims the same corpus gives 2.2 ms against 29.9 ms, 13.6×. The ratio is
 * only meaningful next to its parameters: the narrower the vector, the less a
 * sequential scan costs.
 *
 * Usage:
 *   pnpm bench                       # 2000 notes, 20 queries, 5 repeats
 *   NOTES=20000 pnpm bench           # the corpus size ADR-003 measured on
 *   DIMS=1536 pnpm bench             # a real embedding width
 *   SEED=7 pnpm bench                # a different (still deterministic) corpus
 *   JSON=bench.json pnpm bench       # also write the numbers to a file
 *   KEEP=1 pnpm bench                # leave the workspace behind to inspect
 *   DATABASE_URL=... pnpm bench
 *
 * It creates its own organisation and workspace, and removes them at the end.
 * Nothing else in the database is read or written.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createDb } from '../packages/db/src/client';
import { runMigrations } from '../packages/db/src/migrate';
import * as schema from '../packages/db/src/schema';
import { DrizzleNotesRepository } from '../packages/db/src/notes-repository';
import { DrizzleSearchRepository } from '../packages/db/src/search-repository';
import { partitionNameOf } from '../packages/db/src/embedding-models-repository';
import { SearchService, DeterministicEmbeddingProvider } from '../packages/core/src/index';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';
const NOTES = Number(process.env.NOTES ?? 2000);
const QUERIES = Number(process.env.QUERIES ?? 20);
const REPEATS = Number(process.env.REPEATS ?? 5);
const DIMS = Number(process.env.DIMS ?? 256);
const SEED = Number(process.env.SEED ?? 42);
const TOP_K = Number(process.env.TOP_K ?? 5);
const JSON_OUT = process.env.JSON ?? '';
const KEEP = process.env.KEEP === '1';

/** Same generator as the seed script: reproducible corpora, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vocabulary in the four languages the eval covers, so the lexical lane meets
 * four stemmers rather than one — which is the shape of a real vault since
 * migration 0033.
 */
const TOPICS = [
  { term: 'pgvector', es: 'búsqueda vectorial', en: 'vector search', pt: 'busca vetorial', it: 'ricerca vettoriale' },
  { term: 'docker', es: 'despliegue', en: 'deployment', pt: 'implantação', it: 'distribuzione' },
  { term: 'TOTP', es: 'segundo factor', en: 'second factor', pt: 'segundo fator', it: 'secondo fattore' },
  { term: 'CRDT', es: 'colaboración', en: 'collaboration', pt: 'colaboração', it: 'collaborazione' },
  { term: 'RRF', es: 'fusión de rankings', en: 'rank fusion', pt: 'fusão de rankings', it: 'fusione di classifiche' },
  { term: 'HNSW', es: 'índice vectorial', en: 'vector index', pt: 'índice vetorial', it: 'indice vettoriale' },
  { term: 'backup', es: 'copia de seguridad', en: 'backup', pt: 'cópia de segurança', it: 'copia di sicurezza' },
  { term: 'RLS', es: 'aislamiento por inquilino', en: 'tenant isolation', pt: 'isolamento por inquilino', it: 'isolamento per inquilino' },
];

const FRAMES: Record<'es' | 'en' | 'pt' | 'it', (topic: string, term: string) => string> = {
  es: (t, k) => `Esta nota explica cómo funciona ${t} en el sistema. El componente ${k} se configura al arrancar y se puede revisar después. Cada cambio queda registrado y se puede volver atrás.`,
  en: (t, k) => `This note explains how ${t} works in the system. The ${k} component is configured at boot and can be reviewed later. Every change is recorded and can be rolled back.`,
  pt: (t, k) => `Esta nota explica como ${t} funciona no sistema. O componente ${k} é configurado na inicialização e pode ser revisado depois. Cada alteração fica registrada e pode ser revertida.`,
  it: (t, k) => `Questa nota spiega come funziona ${t} nel sistema. Il componente ${k} viene configurato all'avvio e si può rivedere in seguito. Ogni modifica viene registrata e si può annullare.`,
};

const LANGS = ['es', 'en', 'pt', 'it'] as const;

interface Doc {
  title: string;
  contentMd: string;
}

function corpus(n: number, seed: number): Doc[] {
  const rnd = mulberry32(seed);
  const docs: Doc[] = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)];
    const lang = LANGS[Math.floor(rnd() * LANGS.length)];
    const label = topic[lang];
    const body = [
      FRAMES[lang](label, topic.term),
      FRAMES[lang](TOPICS[Math.floor(rnd() * TOPICS.length)][lang], topic.term),
    ].join('\n\n');
    docs.push({ title: `${label} ${i}`, contentMd: body });
  }
  return docs;
}

/** Queries drawn from the same vocabulary, so every one of them has answers. */
function querySuite(n: number, seed: number): string[] {
  const rnd = mulberry32(seed + 1);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[Math.floor(rnd() * TOPICS.length)];
    const lang = LANGS[Math.floor(rnd() * LANGS.length)];
    out.push(rnd() < 0.3 ? topic.term : topic[lang]);
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[at];
}

interface Timing {
  label: string;
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

function summarise(label: string, ms: number[]): Timing {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    label,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    samples: sorted.length,
  };
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

async function main() {
  const redacted = DATABASE_URL.replace(/:[^:@]+@/, ':***@');
  console.log(
    `[bench] notes=${NOTES} queries=${QUERIES} repeats=${REPEATS} dims=${DIMS} seed=${SEED} topK=${TOP_K}`,
  );
  console.log(`[bench] db=${redacted}`);

  // Same thing the API does at boot. The benchmark writes real notes through
  // the real repositories, so it needs the real schema — and a bench that
  // dies on `column "fts_config" does not exist` is a bench nobody runs twice.
  await runMigrations(DATABASE_URL);

  const { sql, db } = createDb(DATABASE_URL);
  // A second pool that cannot use an index scan. Same URL, same schema, same
  // repository code — the GUC travels in the startup packet, so every
  // connection this pool opens already has it.
  const seqSql = postgres(DATABASE_URL, {
    max: 1,
    connection: { enable_indexscan: 'off', enable_bitmapscan: 'off' },
  });
  const seqDb = drizzle(seqSql, { schema });

  const stamp = `bench-${Date.now()}`;
  let orgId = '';
  let slot = '';
  try {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email) VALUES (${`${stamp}@diluxite`}) RETURNING id`;
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES (${stamp}, ${stamp}) RETURNING id`;
    const [space] = await sql<{ id: string }[]>`
      INSERT INTO spaces (name, owner_id, org_id) VALUES (${stamp}, ${user.id}, ${org.id})
      RETURNING id`;
    await sql`INSERT INTO memberships (space_id, user_id, role) VALUES (${space.id}, ${user.id}, 'owner')`;
    orgId = org.id;
    const spaceId = space.id;

    const notesRepo = new DrizzleNotesRepository(db);
    const searchRepo = new DrizzleSearchRepository(db);
    const embedder = new DeterministicEmbeddingProvider(DIMS);
    const search = new SearchService(searchRepo, embedder, notesRepo);
    slot = search.vectorSpaceOf(orgId, embedder).slot;

    // ── Indexing ────────────────────────────────────────────────────────────
    const docs = corpus(NOTES, SEED);
    const indexMs: number[] = [];
    const startedIndexing = performance.now();
    for (let i = 0; i < docs.length; i++) {
      const at = performance.now();
      const note = await notesRepo.create({ spaceId, ...docs[i] });
      await search.index(note);
      indexMs.push(performance.now() - at);
      if ((i + 1) % 500 === 0) console.log(`[bench] indexed ${i + 1}/${docs.length}`);
    }
    const totalIndexing = performance.now() - startedIndexing;
    const [{ count: chunkCount }] = await sql<{ count: string }[]>`
      SELECT count(*) FROM chunks WHERE space_id = ${spaceId}`;

    console.log(
      `[bench] indexed ${docs.length} notes → ${chunkCount} chunks in ${(totalIndexing / 1000).toFixed(1)} s ` +
        `(${(docs.length / (totalIndexing / 1000)).toFixed(1)} notes/s)`,
    );

    // ── Searching ───────────────────────────────────────────────────────────
    const queries = querySuite(QUERIES, SEED);
    // One untimed pass so the planner has statistics and the caches are warm:
    // otherwise the first query of the first lane pays for all of them.
    await sql`ANALYZE chunks`;
    for (const q of queries.slice(0, 5)) await search.search(spaceId, q, TOP_K);

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const at = performance.now();
      await fn();
      return performance.now() - at;
    };

    const lanes: Timing[] = [];
    const collect = async (label: string, run: (q: string) => Promise<unknown>) => {
      const samples: number[] = [];
      for (let r = 0; r < REPEATS; r++) {
        for (const q of queries) samples.push(await time(() => run(q)));
      }
      const t = summarise(label, samples);
      lanes.push(t);
      console.log(`[bench] ${label.padEnd(26)} p50 ${ms(t.p50).padStart(9)}   p95 ${ms(t.p95).padStart(9)}`);
      return t;
    };

    await collect('keyword (FTS)', (q) => search.search(spaceId, q, TOP_K, 'keyword'));
    await collect('semantic (HNSW)', (q) => search.search(spaceId, q, TOP_K, 'semantic'));
    await collect('hybrid (RRF + rerank)', (q) => search.search(spaceId, q, TOP_K));

    // The same shipped query, over the pool that cannot use an index.
    const seqRepo = new DrizzleSearchRepository(seqDb);
    const seqSearch = new SearchService(seqRepo, embedder, new DrizzleNotesRepository(seqDb));
    await collect('semantic (seq scan)', (q) => seqSearch.search(spaceId, q, TOP_K, 'semantic'));

    // ── What the index itself is worth ──────────────────────────────────────
    //
    // Measured on `vectorSearch`, not on `search()`. The service around it
    // embeds the query and then loads each hit's note — real work, identical
    // in both runs, and enough of the total to hide the thing being compared:
    // at 5k vectors the whole-lane ratio reads 1.4× while the query itself is
    // several times that. This is still the shipped call, just without the
    // constant that both sides pay.
    const vectorSpace = search.vectorSpaceOf(orgId, embedder);
    const embeddings = new Map<string, number[]>();
    for (const q of queries) embeddings.set(q, (await embedder.embed([q]))[0]);
    const candidates = Math.max(TOP_K * 4, 20);

    const indexed = await collect('  └ vectorSearch (HNSW)', (q) =>
      searchRepo.vectorSearch(spaceId, embeddings.get(q)!, candidates, vectorSpace),
    );
    const scanned = await collect('  └ vectorSearch (seq scan)', (q) =>
      seqRepo.vectorSearch(spaceId, embeddings.get(q)!, candidates, vectorSpace),
    );

    const speedup = indexed.p50 > 0 ? scanned.p50 / indexed.p50 : 0;
    console.log(
      `[bench] HNSW vs sequential scan: ${ms(indexed.p50)} vs ${ms(scanned.p50)} → ${speedup.toFixed(1)}× ` +
        `(over ${chunkCount} vectors, ${DIMS} dims)`,
    );

    if (JSON_OUT) {
      const fs = await import('node:fs');
      fs.writeFileSync(
        JSON_OUT,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            params: { notes: NOTES, queries: QUERIES, repeats: REPEATS, dims: DIMS, seed: SEED, topK: TOP_K },
            corpus: { notes: docs.length, chunks: Number(chunkCount) },
            indexing: {
              totalSeconds: totalIndexing / 1000,
              notesPerSecond: docs.length / (totalIndexing / 1000),
              perNote: summarise('index note', indexMs),
            },
            lanes,
            hnswSpeedup: speedup,
          },
          null,
          2,
        ),
      );
      console.log(`[bench] wrote ${JSON_OUT}`);
    }
  } finally {
    if (!KEEP && orgId) {
      // The organisation cascades to its spaces, notes and chunks; the
      // partition is DDL and outlives the rows, so it goes explicitly.
      await sql`DELETE FROM organizations WHERE id = ${orgId}`;
      if (slot) await sql.unsafe(`DROP TABLE IF EXISTS ${partitionNameOf(slot)}`);
      await sql`DELETE FROM embedding_models WHERE org_id = ${orgId}`;
      console.log('[bench] cleaned up');
    } else if (KEEP) {
      console.log(`[bench] KEEP=1 — organisation ${orgId} left in place`);
    }
    await sql.end();
    await seqSql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
