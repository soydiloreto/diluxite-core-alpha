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

  it('GET /info expone el motor de embeddings activo', async () => {
    const r = await app.inject({ url: '/api/info' });
    expect(r.json().embedder).toBe('local');
    expect(r.json().version).toBeTruthy();
  });

  it('GET /stats cuenta notas, tags y links', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/stats` });
    const s = r.json() as { notas: number; tags: number; links: number };
    expect(s.notas).toBe(2);
    expect(s.links).toBe(1); // Azure → MUG
    expect(s.tags).toBeGreaterThanOrEqual(2);
  });

  it('búsqueda en modo keyword encuentra por palabra exacta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'pgvector', mode: 'keyword' },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });

  it('GET /info incluye el usuario autenticado', async () => {
    const r = await app.inject({ url: '/api/info' });
    const j = r.json() as { user: { email: string } };
    expect(j.user?.email).toBe('local@diluxite');
  });

  it('carpetas: crear, listar, renombrar, mover, borrar', async () => {
    const crear = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/carpetas`,
      payload: { nombre: 'Trabajo' },
    });
    expect(crear.statusCode).toBe(201);
    const id = crear.json().id;

    const sub = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/carpetas`,
      payload: { nombre: 'Proyectos', padreId: id },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().padreId).toBe(id);

    const list = await app.inject({ url: `/api/spaces/${spaceId}/carpetas` });
    expect(list.json()).toHaveLength(2);

    const ren = await app.inject({
      method: 'PUT',
      url: `/api/carpetas/${id}`,
      payload: { nombre: 'Trabajo 2026' },
    });
    expect(ren.json().nombre).toBe('Trabajo 2026');

    const del = await app.inject({ method: 'DELETE', url: `/api/carpetas/${id}` });
    expect(del.statusCode).toBe(200);
    // cascade borra la subcarpeta
    expect((await app.inject({ url: `/api/spaces/${spaceId}/carpetas` })).json()).toHaveLength(0);
  });

  it('asigna carpeta a una nota y filtra por carpeta', async () => {
    const carp = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/carpetas`,
      payload: { nombre: 'C' },
    });
    const cid = carp.json().id;
    const crear = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { titulo: 'En carpeta', contenidoMd: 'x', carpetaId: cid },
    });
    expect(crear.json().carpetaId).toBe(cid);
    const dentro = await app.inject({ url: `/api/spaces/${spaceId}/notes?carpeta=${cid}` });
    expect((dentro.json() as { titulo: string }[]).map((n) => n.titulo)).toEqual(['En carpeta']);
    const raiz = await app.inject({ url: `/api/spaces/${spaceId}/notes?carpeta=root` });
    expect((raiz.json() as unknown[]).length).toBe(2); // Azure + MUG en raíz
  });

  it('toggle de favorita y borrado masivo', async () => {
    const fav = await app.inject({
      method: 'PUT',
      url: `/api/notes/${azureId}/favorita`,
      payload: { favorita: true },
    });
    expect(fav.json().favorita).toBe(true);

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/notes/delete-many',
      payload: { ids: [azureId, mugId] },
    });
    expect(bulk.json().deleted).toBe(2);
  });
});

