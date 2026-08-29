import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * `GET /api/admin/embeddings` — the answer to "is semantic search actually
 * working here?".
 *
 * The failure this exists for is silent by construction. Swap the embedding
 * model and every vector already stored has the wrong dimension; pgvector
 * then aborts the semantic half of a hybrid search with `different vector
 * dimensions`, keyword search absorbs the query, and results keep coming
 * back. Nothing errors where anyone can see it. Before this endpoint the only
 * trace was a warning printed once at boot into the container log.
 */
describe('admin embeddings health', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const get = async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/embeddings' });
    expect(r.statusCode).toBe(200);
    return r.json();
  };

  const createNote = async (title: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd: `# ${title}\n\ncuerpo con algo de texto para que haya chunks.\n` },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  it('describes the active embedder without leaking a secret', async () => {
    const body = await get();
    expect(body.active).toMatchObject({
      provider: expect.any(String),
      semantic: expect.any(Boolean),
      dimensions: expect.any(Number),
    });
    // The deterministic provider is what a test install runs, and the point
    // of reporting `semantic` is that this reads as NOT semantic.
    expect(body.active.provider).toBe('local');
    expect(body.active.semantic).toBe(false);
    // Nothing shaped like a credential may cross this boundary.
    expect(JSON.stringify(body)).not.toMatch(/apiKey|api_key|password|secret/i);
  });

  it('reports what is stored, grouped by dimension', async () => {
    await createNote('Uno');
    await createNote('Dos');

    const body = await get();
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.stored).toHaveLength(1);
    expect(body.stored[0].dimensions).toBe(body.active.dimensions);
    expect(body.stored[0].chunks).toBe(body.chunks);
    expect(body.reindexRequired).toBe(false);
  });

  it('flags a reindex when stored vectors have another dimension', async () => {
    await createNote('Uno');
    const active = (await get()).active.dimensions as number;

    // Simulate the model swap: rewrite the stored vectors at a different
    // dimension, which is exactly the state a provider change leaves behind.
    const other = active + 8;
    await sql.unsafe(
      `UPDATE chunks SET embedding = (SELECT ('[' || string_agg('0.1', ',') || ']')::vector
       FROM generate_series(1, ${other}))`,
    );

    const body = await get();
    expect(body.reindexRequired).toBe(true);
    expect(body.stored).toEqual([{ dimensions: other, chunks: body.chunks }]);
  });

  it('flags a half-finished reindex, where BOTH dimensions are present', async () => {
    // The state a single-row probe reports as healthy half the time — and the
    // one where search fails for some queries and not others.
    await createNote('Uno');
    await createNote('Dos');
    const active = (await get()).active.dimensions as number;
    const other = active + 8;
    await sql.unsafe(
      `UPDATE chunks SET embedding = (SELECT ('[' || string_agg('0.1', ',') || ']')::vector
       FROM generate_series(1, ${other}))
       WHERE id IN (SELECT id FROM chunks LIMIT 1)`,
    );

    const body = await get();
    expect(body.reindexRequired).toBe(true);
    expect(body.stored.map((g: { dimensions: number }) => g.dimensions).sort()).toEqual(
      [active, other].sort(),
    );
  });

  it('flags chunks the embedder never reached', async () => {
    await createNote('Uno');
    await sql`UPDATE chunks SET embedding = NULL`;

    const body = await get();
    expect(body.chunksWithoutEmbedding).toBe(body.chunks);
    expect(body.stored).toEqual([]);
    expect(body.reindexRequired).toBe(true);
  });

  it('a reindex clears the flag', async () => {
    await createNote('Uno');
    await sql`UPDATE chunks SET embedding = NULL`;
    expect((await get()).reindexRequired).toBe(true);

    const r = await app.inject({ method: 'POST', url: '/api/admin/reindex', payload: {} });
    expect(r.statusCode).toBe(200);

    const body = await get();
    expect(body.reindexRequired).toBe(false);
    expect(body.chunksWithoutEmbedding).toBe(0);
  });
});
