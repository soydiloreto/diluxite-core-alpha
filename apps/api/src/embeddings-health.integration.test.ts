import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * `GET /api/admin/embeddings` — is semantic search actually working here?
 *
 * The failure is silent by construction. Change the embedding model and every
 * stored vector belongs to a different vector space; pgvector then answers
 * from whatever is in the live model's partition, keyword search absorbs the
 * rest, and results keep coming back. Nothing errors where anyone can see it.
 *
 * Rewritten for ADR-003. The previous version compared DIMENSIONS, which
 * cannot see a swap between two models that share one — the exact case that
 * would let an administrator break search from the UI and be told everything
 * is fine. Reporting is now per model.
 */
describe('admin embeddings health', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let orgId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    orgId = t.defaultOrgId;
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

  it('describes the configured embedder without leaking a secret', async () => {
    const body = await get();
    expect(body.active).toMatchObject({
      provider: expect.any(String),
      semantic: expect.any(Boolean),
      dimensions: expect.any(Number),
    });
    expect(body.active.provider).toBe('local');
    expect(body.active.semantic).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|api_key|password|secret/i);
  });

  it('names the LIVE model, which is a row and not an assumption', async () => {
    const body = await get();
    expect(body.live).toMatchObject({ state: 'active', dimensions: expect.any(Number) });
    // The environment and the database agree on a normal boot.
    expect(body.live.key).toBe(body.configuredKey);
    expect(body.migrationInFlight).toBe(false);
  });

  it('reports vectors per model, and a clean corpus needs no reindex', async () => {
    await createNote('Uno');
    await createNote('Dos');

    const body = await get();
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.stored).toHaveLength(1);
    expect(body.stored[0]).toMatchObject({ state: 'active', chunks: body.chunks });
    expect(body.chunksWithoutEmbedding).toBe(0);
    expect(body.reindexRequired).toBe(false);
  });

  it('flags chunks the live model has no vector for', async () => {
    await createNote('Uno');
    // A provider that was down while notes were being saved leaves exactly
    // this behind: text indexed, vectors missing.
    await sql`DELETE FROM chunk_embeddings`;

    const body = await get();
    expect(body.chunksWithoutEmbedding).toBe(body.chunks);
    expect(body.reindexRequired).toBe(true);
  });

  it('sees a swap between two models of the SAME dimension', async () => {
    // The case the dimension-based check could not see, and the reason this
    // file was rewritten. Both models are 1536; only the key tells them apart.
    await createNote('Uno');
    const before = await get();
    const liveKey = before.live.key as string;
    const dims = before.live.dimensions as number;

    const twin = `voyage:voyage-3@${dims}`;
    const twinSlot = `${orgId}:${twin}`;
    await sql`INSERT INTO embedding_models (key, org_id, slot, provider, model, dimensions, state)
              VALUES (${twin}, ${orgId}, ${twinSlot}, 'voyage', 'voyage-3', ${dims}, 'building')`;
    // Move the vectors to the twin, as a careless swap would.
    await sql`UPDATE embedding_models SET state = 'retired' WHERE org_id = ${orgId} AND key = ${liveKey}`;
    await sql`UPDATE embedding_models SET state = 'active' WHERE slot = ${twinSlot}`;

    const after = await get();
    expect(after.live.key).toBe(twin);
    // The live model owns no vectors, so the corpus is reported as needing one
    // — which under the old dimension check read as perfectly healthy.
    expect(after.chunksWithoutEmbedding).toBe(after.chunks);
    expect(after.reindexRequired).toBe(true);
    expect(after.stored.map((m: { key: string }) => m.key).sort()).toEqual([liveKey, twin].sort());
  });

  it('says when the configured embedder is not yet the live one', async () => {
    await createNote('Uno');
    const before = await get();
    const other = 'ollama:mxbai-embed-large@1024';
    const otherSlot = `${orgId}:${other}`;
    await sql`UPDATE embedding_models SET state = 'retired' WHERE org_id = ${orgId} AND key = ${before.live.key}`;
    await sql`INSERT INTO embedding_models (key, org_id, slot, provider, model, dimensions, state)
              VALUES (${other}, ${orgId}, ${otherSlot}, 'ollama', 'mxbai-embed-large', 1024, 'active')`;

    const after = await get();
    expect(after.migrationInFlight).toBe(true);
    expect(after.configuredKey).toBe(before.live.key);
    expect(after.live.key).toBe(other);
  });

  it('a reindex fills the live model and clears the flag', async () => {
    await createNote('Uno');
    await sql`DELETE FROM chunk_embeddings`;
    expect((await get()).reindexRequired).toBe(true);

    const r = await app.inject({ method: 'POST', url: '/api/admin/reindex', payload: {} });
    expect(r.statusCode).toBe(200);

    const body = await get();
    expect(body.reindexRequired).toBe(false);
    expect(body.chunksWithoutEmbedding).toBe(0);
  });
});
