import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * `/metrics` — what an operator can scrape, and who is allowed to.
 *
 * The endpoint is opt-in on purpose: it lists every route, its traffic and the
 * running version, which is a map of the installation. Default-on with no
 * credential would be one more thing an operator has to remember to close.
 */

const TOKEN = 'scrape-me-please';

describe('metrics endpoint', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  const before = process.env.DILUXITE_METRICS_TOKEN;

  afterEach(async () => {
    await app?.close();
    await sql?.end();
    if (before === undefined) delete process.env.DILUXITE_METRICS_TOKEN;
    else process.env.DILUXITE_METRICS_TOKEN = before;
  });

  const start = async (token: string | undefined) => {
    if (token === undefined) delete process.env.DILUXITE_METRICS_TOKEN;
    else process.env.DILUXITE_METRICS_TOKEN = token;
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
  };

  it('does not exist when no token is configured', async () => {
    await start(undefined);
    const r = await app.inject({ method: 'GET', url: '/metrics' });
    expect(r.statusCode).toBe(404);
  });

  it('answers 404, not 401, without the token', async () => {
    // A 401 would confirm the endpoint is there and worth attacking.
    await start(TOKEN);
    for (const headers of [{}, { authorization: 'Bearer nope' }, { authorization: TOKEN }]) {
      const r = await app.inject({ method: 'GET', url: '/metrics', headers });
      expect(r.statusCode).toBe(404);
    }
  });

  it('renders what the process did, in exposition format', async () => {
    await start(TOKEN);
    // Something to count, through a real route.
    const created = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Métricas', contentMd: 'una nota' },
    });
    expect(created.statusCode).toBe(201);

    const r = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');

    const body = r.body;
    expect(body).toContain('# TYPE diluxite_http_requests_total counter');
    expect(body).toContain(
      'diluxite_http_requests_total{method="POST",route="/api/spaces/:spaceId/notes",status="201"} 1',
    );
    expect(body).toContain('# TYPE diluxite_http_request_duration_seconds histogram');
    expect(body).toContain('diluxite_build_info');
    expect(body).toContain('diluxite_process_uptime_seconds');
    // Saving a note embeds it, and that call is counted through the decorator
    // rather than inside each provider.
    expect(body).toContain('diluxite_embedding_calls_total{outcome="ok",provider="local"}');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('labels a request by its ROUTE, so a scanner cannot mint series', async () => {
    // `/api/notes/:id` is one series. The paths it resolves from are one per
    // note — and made-up paths would be one per request, which is how a
    // time-series database gets filled from outside.
    await start(TOKEN);
    for (const url of ['/api/does-not-exist', '/api/also-not-here', '/api/nor-this']) {
      await app.inject({ method: 'GET', url });
    }
    const r = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.body).toContain('route="unmatched"');
    expect(r.body).not.toContain('does-not-exist');
  });
});
