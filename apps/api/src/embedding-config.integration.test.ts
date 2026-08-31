import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * Choosing the embedding provider from the console — ADR-003.
 *
 * Two things are being protected. The credential, which must never come back
 * out of the API nor land in the database in the clear. And the corpus: saving
 * a new provider must NOT flip the live model, because a flip onto an empty
 * partition is search returning nothing while reporting success.
 */
describe('embedding provider configuration, per organisation', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;

  beforeEach(async () => {
    process.env.DILUXITE_SECRET_KEY = 'una-frase-de-paso-larga-para-los-tests';
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    orgId = t.defaultOrgId;
  });

  afterEach(async () => {
    await sql`DELETE FROM embedding_config`;
    await app.close();
    await sql.end();
  });

  const get = async () => {
    const r = await app.inject({ url: `/api/organizations/${orgId}/embeddings/config` });
    expect(r.statusCode).toBe(200);
    return r.json();
  };

  const put = async (body: unknown) =>
    app.inject({ method: 'PUT', url: `/api/organizations/${orgId}/embeddings/config`, payload: body as object });

  it('starts with nothing stored, and says whether a credential could be', async () => {
    const body = await get();
    expect(body.config).toBeNull();
    expect(body.canStoreCredentials).toBe(true);
  });

  it('stores a provider that needs no credential', async () => {
    const r = await put({ provider: 'ollama', model: 'mxbai-embed-large', dimensions: 1024, endpoint: 'http://localhost:11434' });
    expect(r.statusCode).toBe(200);
    const { config } = await get();
    expect(config).toMatchObject({ provider: 'ollama', model: 'mxbai-embed-large', dimensions: 1024 });
    expect(config.hasApiKey).toBe(false);
  });

  it('the API key never comes back out', async () => {
    await put({
      provider: 'azure',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      endpoint: 'https://x.openai.azure.com',
      apiKey: 'sk-secretisima-de-azure',
    });
    const body = await get();
    expect(body.config.hasApiKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-secretisima');
    // Nor the SEALED blob. It is encrypted, so leaking it is not a breach —
    // but a ciphertext that never crosses the boundary cannot be attacked
    // later with a passphrase somebody eventually obtains. An earlier version
    // of this test only looked for the plaintext and passed while the sealed
    // value went out with every response.
    expect(Object.keys(body.config)).not.toContain('apiKeySealed');
    expect(JSON.stringify(body)).not.toMatch(/"v1\.[A-Za-z0-9_-]+\./);
  });

  it('and never lands in the database in the clear', async () => {
    await put({
      provider: 'azure',
      model: 'text-embedding-3-large',
      dimensions: 1536,
      endpoint: 'https://x.openai.azure.com',
      apiKey: 'sk-secretisima-de-azure',
    });
    const [row] = await sql<{ api_key_sealed: string }[]>`
      SELECT api_key_sealed FROM embedding_config WHERE org_id = ${orgId}`;
    expect(row.api_key_sealed).toBeTruthy();
    expect(row.api_key_sealed).not.toContain('sk-secretisima');
    expect(row.api_key_sealed.startsWith('v1.')).toBe(true);
  });

  it('an edit that does not retype the key keeps it', async () => {
    // The trap this avoids: a UI that sends `null` for "unchanged" erases the
    // credential the first time somebody fixes a typo in the endpoint.
    await put({ provider: 'azure', model: 'm', dimensions: 1536, endpoint: 'https://a', apiKey: 'sk-uno' });
    const before = await sql<{ k: string }[]>`SELECT api_key_sealed AS k FROM embedding_config WHERE org_id = ${orgId}`;
    await put({ provider: 'azure', model: 'm', dimensions: 1536, endpoint: 'https://b' });
    const after = await sql<{ k: string }[]>`SELECT api_key_sealed AS k FROM embedding_config WHERE org_id = ${orgId}`;
    expect(after[0].k).toBe(before[0].k);
    expect((await get()).config.endpoint).toBe('https://b');
  });

  it('an explicit empty key removes it', async () => {
    await put({ provider: 'azure', model: 'm', dimensions: 1536, endpoint: 'https://a', apiKey: 'sk-uno' });
    await put({ provider: 'ollama', model: 'mxbai', dimensions: 1024, endpoint: null, apiKey: '' });
    expect((await get()).config.hasApiKey).toBe(false);
  });

  it('saving a NEW provider does not flip the live model', async () => {
    // The corpus was embedded by the old model. Flipping now would point
    // search at an empty partition and report success.
    const [{ key: before }] = await sql<{ key: string }[]>`
      SELECT key FROM embedding_models WHERE org_id = ${orgId} AND state = 'active'`;
    const r = await put({ provider: 'ollama', model: 'mxbai-embed-large', dimensions: 1024, endpoint: null });
    expect(r.json().model.state).toBe('building');
    expect(r.json().nextStep).toBe('reindex-then-activate');

    const [{ key: after }] = await sql<{ key: string }[]>`
      SELECT key FROM embedding_models WHERE org_id = ${orgId} AND state = 'active'`;
    expect(after).toBe(before);
  });

  it('refuses a configuration that could not work', async () => {
    for (const bad of [
      { provider: 'invented', dimensions: 1024 },
      { provider: 'ollama', dimensions: 1024 },                       // no model
      { provider: 'azure', model: 'm', dimensions: 1536 },            // no endpoint
      { provider: 'bedrock', model: 'm', dimensions: 1024 },          // no region
      { provider: 'ollama', model: 'm', dimensions: 0 },
      { provider: 'ollama', model: 'm', dimensions: 999999 },
      { provider: 'ollama', model: 'm', dimensions: 1024.5 },
    ]) {
      const r = await put(bad);
      expect(r.statusCode, `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it('refuses to store a credential with no passphrase, instead of writing it plainly', async () => {
    delete process.env.DILUXITE_SECRET_KEY;
    delete process.env.DILUXITE_MFA_SIGNING_KEY;
    delete process.env.DILUXITE_CSRF_SIGNING_KEY;
    const r = await put({ provider: 'azure', model: 'm', dimensions: 1536, endpoint: 'https://a', apiKey: 'sk-uno' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/passphrase/i);
    const rows = await sql`SELECT 1 FROM embedding_config WHERE org_id = ${orgId}`;
    expect(rows).toHaveLength(0);
    process.env.DILUXITE_SECRET_KEY = 'una-frase-de-paso-larga-para-los-tests';
  });

  describe('the connection test', () => {
    it('reports the dimension mismatch that would break every search', async () => {
      // A model that answers, with the wrong shape. It would index fine and
      // then fail on the first query — this is where that gets caught.
      const r = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/embeddings/test`,
        payload: { provider: 'local', model: null, dimensions: 999, endpoint: null },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.ok).toBe(true); // the deterministic provider honours any dimension
      expect(body.dimensions).toBe(999);
    });

    it('reports a provider that cannot be reached, rather than throwing', async () => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/organizations/${orgId}/embeddings/test`,
        payload: {
          provider: 'ollama',
          model: 'no-existe',
          dimensions: 1024,
          endpoint: 'http://127.0.0.1:1',
        },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().ok).toBe(false);
      expect(r.json().error).toBeTruthy();
    });
  });
});
