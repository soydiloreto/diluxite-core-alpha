import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from './app';
import { buildCoreDeps } from './services';
import { TEST_DATABASE_URL } from '../test/setup-integration';

/**
 * Saving the provider has to reach the running process.
 *
 * The embedder an organisation searches with is built once and memoised —
 * reading its configuration is a query and every search asks. Nothing told
 * that memo when the configuration changed, so an admin could point the
 * organisation at a different endpoint, see it saved, and the process would
 * go on embedding with the old provider until somebody restarted the
 * container. The console promised a setting and delivered a note-to-self.
 *
 * The assertion is on the wiring rather than on a second embedding, because
 * that is where the defect was: the memo itself is a Map, and the route that
 * writes the configuration is the only thing that can know it is stale.
 */
describe('writing the embedding configuration invalidates the memoised provider', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;
  let forgotten: string[];

  beforeEach(async () => {
    process.env.DILUXITE_SECRET_KEY = 'una-frase-de-paso-larga-para-los-tests';
    const r = await buildCoreDeps(TEST_DATABASE_URL);
    sql = r.sql;
    orgId = r.defaultOrgId;
    forgotten = [];
    app = await buildApp({
      ...r.deps,
      forgetOrgEmbedder: (org: string) => forgotten.push(org),
    });
    await app.ready();
  });

  afterEach(async () => {
    await sql`DELETE FROM embedding_config`;
    await app.close();
    await sql.end();
  });

  const put = (body: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/embeddings/config`,
      payload: body as object,
    });

  it('a saved provider is forgotten, so the next search builds it again', async () => {
    const r = await put({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 1024,
      endpoint: 'http://localhost:11434',
    });
    expect(r.statusCode).toBe(200);
    expect(forgotten, 'the running process was never told the provider changed').toEqual([orgId]);
  });

  it('and so is a change of endpoint alone — the one expected to take effect now', async () => {
    await put({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 1024,
      endpoint: 'http://localhost:11434',
    });
    forgotten = [];
    const r = await put({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 1024,
      endpoint: 'http://ollama.interno:11434',
    });
    expect(r.statusCode).toBe(200);
    expect(forgotten).toEqual([orgId]);
  });

  it('a rejected configuration forgets nothing', async () => {
    const r = await put({ provider: 'azure', model: 'text-embedding-3-large', dimensions: 1536 });
    expect(r.statusCode).toBe(400); // azure needs an endpoint
    expect(forgotten).toEqual([]);
  });
});
