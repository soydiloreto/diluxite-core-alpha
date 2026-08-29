import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../test/helpers';

/**
 * Search configuration belongs to the organisation, not to a browser.
 *
 * The control sat in the admin console and wrote to localStorage, so an
 * administrator configured their laptop believing they had configured the
 * org — a setting that lied about its own scope.
 */

describe('per-organization search configuration', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let orgId: string;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    orgId = t.defaultOrgId;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const get = async () =>
    (await app.inject({ method: 'GET', url: `/api/organizations/${orgId}/search-config` })).json();

  // Typed rather than `unknown`: an unknown payload makes TypeScript pick the
  // wrong `inject` overload, and the error it then reports is about the
  // response shape instead of about the argument.
  const put = async (body: Record<string, unknown>): Promise<LightMyRequestResponse> => {
    return await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/search-config`,
      payload: body,
    });
  };

  it('defaults to what the client used, so an untouched install is unchanged', async () => {
    expect(await get()).toEqual({ mode: 'hybrid', topK: 5 });
  });

  it('persists a change and reads it back', async () => {
    expect((await put({ mode: 'keyword', topK: 12 })).statusCode).toBe(200);
    expect(await get()).toEqual({ mode: 'keyword', topK: 12 });
  });

  it('refuses a mode the engine does not implement', async () => {
    const r = await put({ mode: 'telepathic', topK: 5 });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('search.invalidMode');
    // And nothing was written.
    expect(await get()).toEqual({ mode: 'hybrid', topK: 5 });
  });

  it('bounds topK at both ends', async () => {
    // Unbounded, topK feeds a candidate multiplier — one query becomes a very
    // expensive scan, and this setting is shared by the whole org.
    for (const topK of [0, -1, 51, 1.5]) {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/organizations/${orgId}/search-config`,
        payload: { mode: 'hybrid', topK },
      });
      expect(r.statusCode, `topK=${topK}`).toBe(400);
      expect(r.json().code).toBe('search.invalidTopK');
    }
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/search-config`,
      payload: { mode: 'hybrid', topK: 50 },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('localises the refusal like every other error', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${orgId}/search-config`,
      headers: { 'accept-language': 'es' },
      payload: { mode: 'telepathic', topK: 5 },
    });
    expect(r.json().error).toContain('modo de búsqueda');
  });

  // The point of the whole change: the setting has to reach the engine.
  it('search uses the org default when the request does not ask for a mode', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Azure', contentMd: 'Azure is the Microsoft cloud' },
    });
    await put({ mode: 'keyword', topK: 3 });

    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'Azure', spaceId },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it('an explicit request still wins over the org default', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Azure', contentMd: 'Azure is the Microsoft cloud' },
    });
    await put({ mode: 'keyword', topK: 1 });

    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'Azure', spaceId, topK: 5, mode: 'hybrid' },
    });
    expect(r.statusCode).toBe(200);
  });
});
