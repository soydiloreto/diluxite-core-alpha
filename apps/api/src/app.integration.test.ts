import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../test/helpers';

describe('API REST (integración con inject)', () => {
  let app: FastifyInstance;
  // deps de buildTestApp (incluye sql y defaultSpaceId)
  let deps: Awaited<ReturnType<typeof buildTestApp>>['deps'];

  beforeEach(async () => {
    ({ app, deps } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await deps.sql.end();
  });

  it('GET /health responde ok', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().service).toBe('diluxite-core');
  });

  it('lista el espacio por defecto', async () => {
    const r = await app.inject({ url: '/api/spaces' });
    expect(r.statusCode).toBe(200);
    expect(r.json().length).toBeGreaterThanOrEqual(1);
  });

  it('ciclo completo: crear → leer → listar → buscar → borrar', async () => {
    const sid = deps.defaultSpaceId;

    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${sid}/notes`,
      payload: { titulo: 'Azure', contenidoMd: 'Azure es la nube de Microsoft' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const get = await app.inject({ url: `/api/notes/${id}` });
    expect(get.json().titulo).toBe('Azure');

    const list = await app.inject({ url: `/api/spaces/${sid}/notes` });
    expect(list.json()).toHaveLength(1);

    const search = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'la nube de microsoft' },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()[0].titulo).toBe('Azure');

    const del = await app.inject({ method: 'DELETE', url: `/api/notes/${id}` });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ url: `/api/notes/${id}` });
    expect(after.statusCode).toBe(404);
  });

  it('PUT actualiza el contenido', async () => {
    const sid = deps.defaultSpaceId;
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${sid}/notes`,
      payload: { titulo: 'T', contenidoMd: 'v1' },
    });
    const id = create.json().id;
    const put = await app.inject({
      method: 'PUT',
      url: `/api/notes/${id}`,
      payload: { contenidoMd: 'v2' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().contenidoMd).toBe('v2');
  });

  it('valida payload: nota sin título => 400', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${deps.defaultSpaceId}/notes`,
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('nota inexistente => 404', async () => {
    const r = await app.inject({ url: '/api/notes/00000000-0000-0000-0000-000000000000' });
    expect(r.statusCode).toBe(404);
  });
});
