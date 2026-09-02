import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * ADR-006: the provider is optional, its credential never comes back, and
 * absent is a working state.
 */
describe('generation provider configuration (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;
  let spaceId: string;

  const url = () => `/api/organizations/${orgId}/generation-config`;

  beforeEach(async () => {
    // Sealing needs a passphrase; without one the route refuses rather than
    // storing a credential in the clear, which the last test asserts.
    process.env.DILUXITE_SECRET_KEY = 'una-frase-de-paso-larga-para-los-tests';
    ({ app, sql, defaultOrgId: orgId, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    delete process.env.DILUXITE_SECRET_KEY;
    await app.close();
    await sql.end();
  });

  it('none configured reads as null, not as an error', async () => {
    const r = await app.inject({ url: url() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toBeNull();
  });

  it('stores it and never hands the key back', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: url(),
      payload: {
        provider: 'openai-compatible',
        model: 'gpt-x',
        endpoint: 'https://model.example/v1/chat/completions',
        apiKey: 'sk-secreta',
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().hasApiKey).toBe(true);
    expect(JSON.stringify(r.json())).not.toContain('sk-secreta');

    const [row] = await sql<{ api_key_sealed: string }[]>`
      SELECT api_key_sealed FROM generation_config WHERE org_id = ${orgId}`;
    // Sealed at rest, never plaintext.
    expect(row.api_key_sealed).not.toContain('sk-secreta');
  });

  it('editing the endpoint keeps the stored key', async () => {
    await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'ollama', model: 'llama', endpoint: 'http://a/v1/chat/completions', apiKey: 'k' },
    });
    // An admin fixing a typo cannot retype a key they are not allowed to read.
    const r = await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'ollama', model: 'llama', endpoint: 'http://b/v1/chat/completions' },
    });
    expect(r.json().endpoint).toBe('http://b/v1/chat/completions');
    expect(r.json().hasApiKey).toBe(true);
  });

  it('refuses a provider it does not speak, and an incomplete one', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'telepathic', model: 'm', endpoint: 'http://x' },
    });
    expect(bad.statusCode).toBe(400);
    const incomplete = await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'ollama', model: '', endpoint: 'http://x' },
    });
    expect(incomplete.statusCode).toBe(400);
  });

  it('clearing it leaves the curation queue working', async () => {
    await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'ollama', model: 'm', endpoint: 'http://x/v1/chat/completions' },
    });
    expect((await app.inject({ method: 'DELETE', url: url() })).statusCode).toBe(200);
    expect((await app.inject({ url: url() })).json()).toBeNull();

    // Off is a working state: the batch still builds, with quoted questions.
    const note = (
      await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: { title: 'Sin proveedor', contentMd: 'x' },
      })
    ).json().id as string;
    await sql`
      INSERT INTO entity_usage (entity_kind, entity_id, space_id, use_count)
      VALUES ('note', ${note}, ${spaceId}, 5)`;
    const built = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/curation/build`,
      payload: {},
    });
    expect(built.json().built).toBe(1);
    expect(built.json().drafted).toBe(false);
  });

  it('testing without a provider configured is a refusal, not a crash', async () => {
    const r = await app.inject({ method: 'POST', url: `${url()}/test`, payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().ok).toBe(false);
  });

  it('refuses to store a key when there is no passphrase to seal it with', async () => {
    delete process.env.DILUXITE_SECRET_KEY;
    const r = await app.inject({
      method: 'PUT',
      url: url(),
      payload: { provider: 'ollama', model: 'm', endpoint: 'http://x', apiKey: 'k' },
    });
    // Storing it in the clear is the alternative, and it is not one.
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/passphrase/i);
  });
});
