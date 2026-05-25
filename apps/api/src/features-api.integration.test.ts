import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

describe('API features: tags, backlinks, grafo, append (integración)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let azureId: string;
  let mugId: string;

  async function crear(titulo: string, contenidoMd: string) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { titulo, contenidoMd },
    });
    return r.json().id as string;
  }

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
    azureId = await crear('Azure', 'la nube #cloud #azure, ver [[MUG]]');
    mugId = await crear('MUG', 'grupo #comunidad');
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('GET /tags lista los tags con conteo', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/tags` });
    expect(r.statusCode).toBe(200);
    const tags = (r.json() as { tag: string }[]).map((t) => t.tag);
    expect(tags).toContain('cloud');
    expect(tags).toContain('comunidad');
  });

  it('GET /notes?tag= filtra por tag', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/notes?tag=azure` });
    const titulos = (r.json() as { titulo: string }[]).map((n) => n.titulo);
    expect(titulos).toEqual(['Azure']);
  });

  it('GET /notes/:id/backlinks devuelve quién enlaza', async () => {
    const r = await app.inject({ url: `/api/notes/${mugId}/backlinks` });
    const titulos = (r.json() as { titulo: string }[]).map((n) => n.titulo);
    expect(titulos).toEqual(['Azure']);
  });

  it('GET /graph devuelve nodos y aristas', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/graph` });
    const g = r.json() as { nodes: unknown[]; edges: { source: string; target: string }[] };
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ source: azureId, target: mugId }]);
  });

  it('POST /notes/:id/append agrega contenido al final', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/notes/${mugId}/append`,
      payload: { contenido: 'línea nueva' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().contenidoMd).toContain('grupo #comunidad');
    expect(r.json().contenidoMd).toContain('línea nueva');
  });
});
