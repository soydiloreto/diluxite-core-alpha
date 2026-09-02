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

  /** The shipped ranking weights, which every untouched org reads (0037). */
  const DEFAULT_WEIGHTS = {
    preferred: 1.2,
    stale: 0.9,
    expired: 0.4,
    correction: 1.5,
    hideExpired: false,
  };

  it('defaults to what the client used, so an untouched install is unchanged', async () => {
    expect(await get()).toEqual({ mode: 'hybrid', topK: 5, weights: DEFAULT_WEIGHTS });
  });

  it('persists a change and reads it back', async () => {
    expect((await put({ mode: 'keyword', topK: 12 })).statusCode).toBe(200);
    expect(await get()).toEqual({ mode: 'keyword', topK: 12, weights: DEFAULT_WEIGHTS });
  });

  it('refuses a mode the engine does not implement', async () => {
    const r = await put({ mode: 'telepathic', topK: 5 });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('search.invalidMode');
    // And nothing was written.
    expect(await get()).toEqual({ mode: 'hybrid', topK: 5, weights: DEFAULT_WEIGHTS });
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

  describe('ranking weights (migration 0037)', () => {
    it('an untouched organisation gets weights that are NOT neutral', async () => {
      const r = await app.inject({ url: `/api/organizations/${orgId}/search-config` });
      expect(r.json().weights).toEqual(DEFAULT_WEIGHTS);
    });

    it('saves the knobs and reads them back', async () => {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/organizations/${orgId}/search-config`,
        payload: {
          mode: 'hybrid',
          topK: 5,
          weights: { preferred: 1.5, stale: 0.8, expired: 0.2, correction: 2, hideExpired: true },
        },
      });
      expect(r.statusCode).toBe(200);
      const back = (
        await app.inject({ url: `/api/organizations/${orgId}/search-config` })
      ).json().weights;
      expect(back).toEqual({
        preferred: 1.5,
        stale: 0.8,
        expired: 0.2,
        correction: 2,
        hideExpired: true,
      });
    });

    it('saving without weights leaves them alone', async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/organizations/${orgId}/search-config`,
        payload: { mode: 'hybrid', topK: 5, weights: { preferred: 1.5, stale: 0.8, expired: 0.2, hideExpired: true } },
      });
      // A client that predates the knobs must not reset them by saving a mode.
      await app.inject({
        method: 'PUT',
        url: `/api/organizations/${orgId}/search-config`,
        payload: { mode: 'keyword', topK: 7 },
      });
      const cfg = (await app.inject({ url: `/api/organizations/${orgId}/search-config` })).json();
      expect(cfg.mode).toBe('keyword');
      expect(cfg.weights.preferred).toBe(1.5);
      expect(cfg.weights.hideExpired).toBe(true);
    });

    it('a weight out of range is a 400, not a 500', async () => {
      const r = await app.inject({
        method: 'PUT',
        url: `/api/organizations/${orgId}/search-config`,
        payload: {
          mode: 'hybrid',
          topK: 5,
          weights: { preferred: 9, stale: 0.9, expired: 0.4, correction: 1.5, hideExpired: false },
        },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe('search.invalidWeights');
    });
  });
});
