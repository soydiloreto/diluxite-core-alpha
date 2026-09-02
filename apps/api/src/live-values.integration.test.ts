import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';
import { liveValuesFor, liveBlock } from './live-values';

/**
 * ADR-001 step 3, end to end. The two rules under test: nothing is called
 * unless an operator allowed the host, and no value is ever served without the
 * date it was true.
 */
describe('live values (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;
  let orgId: string;

  const RESOLVER = [
    '# Métricas',
    '',
    '```resolver',
    'name: mrr',
    'url: https://metrics.example/api/mrr',
    'path: data.value',
    'ttl: 60',
    '```',
  ].join('\n');

  async function noteWith(contentMd: string) {
    return (
      await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/notes`,
        payload: { title: 'Métricas', contentMd },
      })
    ).json().id as string;
  }

  const allow = (host: string, token?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/organizations/${orgId}/resolver-allowlist`,
      payload: { host, ...(token ? { token } : {}) },
    });

  function answering(body: string) {
    return vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => body });
  }

  beforeEach(async () => {
    process.env.DILUXITE_SECRET_KEY = 'una-frase-de-paso-larga-para-los-tests';
    ({ app, sql, deps, defaultSpaceId: spaceId, defaultOrgId: orgId } = await buildTestApp());
  });

  afterEach(async () => {
    delete process.env.DILUXITE_SECRET_KEY;
    vi.unstubAllGlobals();
    await app.close();
    await sql.end();
  });

  it('a host nobody allowed is never called', async () => {
    const f = answering('{"data":{"value":42}}');
    vi.stubGlobal('fetch', f);
    const id = await noteWith(RESOLVER);

    const [v] = await liveValuesFor(deps, spaceId, [id]);
    // The allowlist is the trust boundary: a note must not decide which
    // addresses the server reaches.
    expect(f).not.toHaveBeenCalled();
    expect(v.value).toBeNull();
    expect(v.error).toMatch(/allowlist/i);
  });

  it('an allowed host is called, and the value comes back with its date', async () => {
    vi.stubGlobal('fetch', answering('{"data":{"value":42}}'));
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);

    const [v] = await liveValuesFor(deps, spaceId, [id]);
    expect(v.value).toBe('42');
    expect(v.fetchedAt).not.toBeNull();
    expect(liveBlock([v])).toMatch(/mrr: 42 \(\d+s ago\)/);
  });

  it('within the ttl it answers from cache instead of calling again', async () => {
    const f = answering('{"data":{"value":42}}');
    vi.stubGlobal('fetch', f);
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);

    await liveValuesFor(deps, spaceId, [id]);
    await liveValuesFor(deps, spaceId, [id]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('once the ttl passes it asks again', async () => {
    const f = answering('{"data":{"value":42}}');
    vi.stubGlobal('fetch', f);
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);
    await liveValuesFor(deps, spaceId, [id]);

    await sql`UPDATE resolver_cache SET fetched_at = now() - interval '10 minutes'`;
    await liveValuesFor(deps, spaceId, [id]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a source that goes down keeps the last value AND says it is old', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"data":{"value":42}}' })
      .mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', f);
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);
    await liveValuesFor(deps, spaceId, [id]);
    await sql`UPDATE resolver_cache SET fetched_at = now() - interval '2 hours'`;

    const [v] = await liveValuesFor(deps, spaceId, [id]);
    // Serving a cached value when the source is unreachable is fine. Serving
    // it BARE is not — that is the whole rule.
    expect(v.value).toBe('42');
    expect(v.error).toMatch(/ECONNREFUSED/);
    const block = liveBlock([v])!;
    expect(block).toMatch(/2 hours ago/);
    expect(block).toMatch(/could not refresh/);
  });

  it('a source never reached says "unknown", not a number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('nope')));
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);

    const [v] = await liveValuesFor(deps, spaceId, [id]);
    // A second brain that always answers is one you cannot trust on any
    // single answer.
    expect(v.value).toBeNull();
    expect(liveBlock([v])).toMatch(/unknown/);
  });

  it('sends the operator credential for the host', async () => {
    const f = answering('{"data":{"value":7}}');
    vi.stubGlobal('fetch', f);
    await allow('metrics.example', 'op-secret');
    const id = await noteWith(RESOLVER);

    await liveValuesFor(deps, spaceId, [id]);
    const [, init] = f.mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer op-secret');
    // And it is never stored in the clear.
    const [row] = await sql<{ token_sealed: string }[]>`
      SELECT token_sealed FROM resolver_allowlist WHERE host = 'metrics.example'`;
    expect(row.token_sealed).not.toContain('op-secret');
  });

  it('a note with no resolver block costs nothing', async () => {
    const f = answering('{}');
    vi.stubGlobal('fetch', f);
    const id = await noteWith('# Nota\n\nsolo prosa');
    expect(await liveValuesFor(deps, spaceId, [id])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('GET /api/notes/:id/live answers what the note declares', async () => {
    vi.stubGlobal('fetch', answering('{"data":{"value":42}}'));
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);

    const r = await app.inject({ url: `/api/notes/${id}/live` });
    expect(r.statusCode).toBe(200);
    expect(r.json()[0]).toMatchObject({ name: 'mrr', value: '42' });
  });

  it('the allowlist refuses a URL where a host belongs', async () => {
    // Allowing `https://a.example/metrics` would read as a path restriction
    // that is enforced nowhere.
    expect((await allow('https://metrics.example/api')).statusCode).toBe(400);
    expect((await allow('metrics example')).statusCode).toBe(400);
  });

  it('renaming a resolver drops the value cached under the old name', async () => {
    vi.stubGlobal('fetch', answering('{"data":{"value":42}}'));
    await allow('metrics.example');
    const id = await noteWith(RESOLVER);
    await liveValuesFor(deps, spaceId, [id]);

    await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { contentMd: RESOLVER.replace('name: mrr', 'name: arr') },
    });
    await liveValuesFor(deps, spaceId, [id]);

    const rows = await sql<{ name: string }[]>`SELECT name FROM resolver_cache WHERE note_id = ${id}`;
    expect(rows.map((r) => r.name)).toEqual(['arr']);
  });
});
