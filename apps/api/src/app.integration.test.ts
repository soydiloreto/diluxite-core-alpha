import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

describe('REST API (integration via Fastify inject)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('GET /health responds ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().service).toBe('diluxite-core');
  });

  it('lists the default space', async () => {
    const r = await app.inject({ url: '/api/spaces' });
    expect(r.statusCode).toBe(200);
    expect(r.json().length).toBeGreaterThanOrEqual(1);
  });

  it('full cycle: create → read → list → search → delete', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Azure', contentMd: 'Azure is the Microsoft cloud' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    expect((await app.inject({ url: `/api/notes/${id}` })).json().title).toBe('Azure');
    expect((await app.inject({ url: `/api/spaces/${spaceId}/notes` })).json()).toHaveLength(1);

    const search = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'the microsoft cloud' },
    });
    expect(search.json()[0].title).toBe('Azure');

    expect((await app.inject({ method: 'DELETE', url: `/api/notes/${id}` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/notes/${id}` })).statusCode).toBe(404);
  });

  it('PUT updates the content', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'T', contentMd: 'v1' },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/notes/${create.json().id}`,
      payload: { contentMd: 'v2' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().contentMd).toBe('v2');
  });

  it('validates payload: note without title => 400', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/notes`, payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('missing note => 404', async () => {
    const r = await app.inject({ url: '/api/notes/00000000-0000-0000-0000-000000000000' });
    expect(r.statusCode).toBe(404);
  });
});
