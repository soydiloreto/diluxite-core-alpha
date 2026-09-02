import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const SECRET = 'un-secreto-de-webhook';

/**
 * The webhook's signature IS its authentication, so that is what these tests
 * are about: nothing unsigned reaches a database, and nothing is read before
 * the signature is checked.
 */
describe('github webhook (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let orgId: string;
  let spaceId: string;

  const sign = (body: string) =>
    `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  const post = (body: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push', ...headers },
      payload: body,
    });

  beforeEach(async () => {
    process.env.DILUXITE_GITHUB_APP_ID = '1';
    process.env.DILUXITE_GITHUB_PRIVATE_KEY = PEM;
    process.env.DILUXITE_GITHUB_WEBHOOK_SECRET = SECRET;
    process.env.DILUXITE_GITHUB_APP_SLUG = 'diluxite-test';
    ({ app, sql, deps, defaultOrgId: orgId, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    delete process.env.DILUXITE_GITHUB_APP_ID;
    delete process.env.DILUXITE_GITHUB_PRIVATE_KEY;
    delete process.env.DILUXITE_GITHUB_WEBHOOK_SECRET;
    delete process.env.DILUXITE_GITHUB_APP_SLUG;
    await app.close();
    await sql.end();
  });

  it('refuses an unsigned delivery', async () => {
    const r = await post(JSON.stringify({ installation: { id: 42 } }));
    expect(r.statusCode).toBe(401);
  });

  it('refuses a signature made over a DIFFERENT body', async () => {
    const body = JSON.stringify({ installation: { id: 42 } });
    const r = await post(body, { 'x-hub-signature-256': sign('{"otra":"cosa"}') });
    expect(r.statusCode).toBe(401);
  });

  it('refuses a signature over the re-serialised body', async () => {
    // Key order and whitespace change when a payload is parsed and printed
    // again. Signing the parsed shape instead of the bytes is how this check
    // is broken while still looking correct.
    const body = '{"installation": {"id": 42} }';
    const reserialised = JSON.stringify(JSON.parse(body));
    const r = await post(body, { 'x-hub-signature-256': sign(reserialised) });
    expect(r.statusCode).toBe(401);
  });

  it('accepts a signed delivery and ignores an installation it does not know', async () => {
    const body = JSON.stringify({ installation: { id: 999 } });
    const r = await post(body, { 'x-hub-signature-256': sign(body) });
    expect(r.statusCode).toBe(200);
    expect(r.json().ignored).toBe('unknown installation');
  });

  it('ignores a push to a branch that is not the default one', async () => {
    await deps.github!.connect({ orgId, installationId: '42', spaceId });
    const body = JSON.stringify({
      installation: { id: 42 },
      repository: { full_name: 'acme/docs', default_branch: 'main' },
      ref: 'refs/heads/una-rama',
      commits: [{ added: ['a.md'] }],
    });
    const r = await post(body, { 'x-hub-signature-256': sign(body) });
    // Ingesting every feature branch fills the memory with drafts, and a draft
    // ranking beside a decision is worse than no draft.
    expect(r.json().ignored).toBe('not the default branch');
  });

  it('an event that is not a push is acknowledged, not processed', async () => {
    await deps.github!.connect({ orgId, installationId: '42', spaceId });
    const body = JSON.stringify({ installation: { id: 42 } });
    const r = await post(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'star' });
    expect(r.json().ignored).toBe('star');
  });

  it('with no App configured the route says so instead of pretending', async () => {
    delete process.env.DILUXITE_GITHUB_WEBHOOK_SECRET;
    const body = JSON.stringify({ installation: { id: 42 } });
    const r = await post(body, { 'x-hub-signature-256': sign(body) });
    expect(r.statusCode).toBe(501);
  });
});
