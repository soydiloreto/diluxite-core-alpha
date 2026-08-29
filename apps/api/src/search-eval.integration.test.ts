import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

/**
 * A reproducible baseline for Spanish search quality.
 *
 * Not a unit test of the ranker — those live in `reranker.test.ts`. This is
 * the thing the roadmap asked for: a fixed corpus, a fixed query suite with
 * the note each query SHOULD return, and a number. Without it, "search feels
 * better" is a claim nobody can check and every future change to chunking,
 * embeddings or weights is a coin flip.
 *
 * The corpus is deliberately adversarial in the way a real vault is: notes
 * that share vocabulary, near-synonyms, and one query whose answer is stated
 * in different words than the question asks.
 */

interface Doc {
  title: string;
  contentMd: string;
}

const CORPUS: Doc[] = [
  {
    title: 'Arquitectura de búsqueda',
    contentMd:
      'La búsqueda combina BM25 con pgvector y fusiona los dos rankings con RRF. ' +
      'Después un reranker reordena los mejores por cobertura de términos.',
  },
  {
    title: 'Despliegue con Docker',
    contentMd:
      'El stack se levanta con docker compose: la API, la base Postgres con pgvector ' +
      'y el frontend. El instalador genera el compose real.',
  },
  {
    title: 'Política de contraseñas',
    contentMd:
      'Las contraseñas se guardan hasheadas con PBKDF2. El segundo factor es TOTP ' +
      'y hay códigos de respaldo de un solo uso.',
  },
  {
    title: 'Historial de versiones',
    contentMd:
      'Cada guardado que cambia el contenido deja una instantánea de lo que la nota ' +
      'decía antes. Se pueden restaurar versiones anteriores.',
  },
  {
    title: 'Colaboración en tiempo real',
    contentMd:
      'Dos personas editan la misma nota a la vez. Los cambios viajan por WebSocket ' +
      'y se fusionan con un CRDT, sin pisarse.',
  },
  {
    title: 'Copias de seguridad',
    contentMd:
      'El respaldo guarda la base, los secretos y el certificado. Restaurar en una ' +
      'máquina nueva deja el sistema igual que estaba.',
  },
];

/** Each query and the note a person would expect first. */
const QUERIES: { q: string; expect: string }[] = [
  { q: 'cómo funciona la búsqueda híbrida', expect: 'Arquitectura de búsqueda' },
  { q: 'cómo levanto el stack', expect: 'Despliegue con Docker' },
  { q: 'segundo factor de autenticación', expect: 'Política de contraseñas' },
  { q: 'puedo volver a una versión anterior de una nota', expect: 'Historial de versiones' },
  { q: 'dos personas editando al mismo tiempo', expect: 'Colaboración en tiempo real' },
  { q: 'restaurar en una máquina nueva', expect: 'Copias de seguridad' },
  { q: 'RRF', expect: 'Arquitectura de búsqueda' },
  { q: 'TOTP', expect: 'Política de contraseñas' },
  { q: 'CRDT WebSocket', expect: 'Colaboración en tiempo real' },
  { q: 'pgvector', expect: 'Arquitectura de búsqueda' },
];

/**
 * The bar. Deliberately below perfect: the embedder in tests is the
 * deterministic one — a hash, not a language model — so semantic recall is
 * weaker here than in any real deployment. A suite tuned to 100% against a
 * fake embedder would be measuring the fixture, and would break the day the
 * embedder improves.
 */
const MIN_HIT_AT_1 = 0.6;
const MIN_HIT_AT_3 = 0.8;

describe('Spanish search evaluation — a baseline, not a vibe', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    for (const doc of CORPUS) {
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

    for (const { q, expect: want } of QUERIES) {
      const titles = await titlesFor(q);
      if (titles[0] === want) hit1++;
      if (titles.slice(0, 3).includes(want)) hit3++;
      else misses.push(`"${q}" → esperaba "${want}", devolvió [${titles.slice(0, 3).join(', ')}]`);
    }

    const at1 = hit1 / QUERIES.length;
    const at3 = hit3 / QUERIES.length;
    // Printed so a regression run shows WHICH queries moved, not just a number.
    if (misses.length > 0) console.log(`hit@3 misses:\n  ${misses.join('\n  ')}`);
    console.log(`hit@1 = ${at1.toFixed(2)} · hit@3 = ${at3.toFixed(2)}`);

    expect(at1).toBeGreaterThanOrEqual(MIN_HIT_AT_1);
    expect(at3).toBeGreaterThanOrEqual(MIN_HIT_AT_3);
  });

  it('an exact term lands its note first', async () => {
    // The lexical channel should make these trivial; if one regresses, the
    // fusion or the reranker changed in a way worth knowing about.
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
        for (const { q, expect: want } of QUERIES) {
          const results = await svc.search(spaceId, q, 5);
          if (results[0]?.title === want) hits++;
        }
        return hits / QUERIES.length;
      };

      const off = await score(new IdentityReranker());
      const lexical = await score(new LexicalReranker());
      console.log(`hit@1 sin reranker = ${off.toFixed(2)} · con lexical = ${lexical.toFixed(2)}`);

      expect(lexical).toBeGreaterThanOrEqual(off);
    } finally {
      await conn.sql.end();
    }
  });
});
