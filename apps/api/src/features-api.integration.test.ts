import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

describe('API features: tags, backlinks, graph, append (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let azureId: string;
  let mugId: string;

  async function createNote(title: string, contentMd: string) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd },
    });
    return r.json().id as string;
  }

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
    azureId = await createNote('Azure', 'the cloud #cloud #azure, see [[MUG]]');
    mugId = await createNote('MUG', 'community #comunidad');
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('GET /tags lists tags with their counts', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/tags` });
    expect(r.statusCode).toBe(200);
    const tags = (r.json() as { tag: string }[]).map((t) => t.tag);
    expect(tags).toContain('cloud');
    expect(tags).toContain('comunidad');
  });

  it('GET /notes?tag= filters by tag', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/notes?tag=azure` });
    const titles = (r.json() as { title: string }[]).map((n) => n.title);
    expect(titles).toEqual(['Azure']);
  });

  it('GET /notes/:id/backlinks returns who links here', async () => {
    const r = await app.inject({ url: `/api/notes/${mugId}/backlinks` });
    const titles = (r.json() as { title: string }[]).map((n) => n.title);
    expect(titles).toEqual(['Azure']);
  });

  it('GET /graph returns nodes and edges', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/graph` });
    const g = r.json() as { nodes: unknown[]; edges: { source: string; target: string }[] };
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ source: azureId, target: mugId }]);
  });

  it('POST /notes/:id/append appends content', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/notes/${mugId}/append`,
      payload: { content: 'new line' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().contentMd).toContain('community #comunidad');
    expect(r.json().contentMd).toContain('new line');
  });

  it('GET /info exposes the active embeddings engine', async () => {
    const r = await app.inject({ url: '/api/info' });
    expect(r.json().embedder).toBe('local');
    expect(r.json().version).toBeTruthy();
  });

  it('GET /stats counts notes, tags and links', async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/stats` });
    const s = r.json() as { notes: number; tags: number; links: number };
    expect(s.notes).toBe(2);
    expect(s.links).toBe(1); // Azure → MUG
    expect(s.tags).toBeGreaterThanOrEqual(2);
  });

  it('keyword-mode search matches by exact word', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'pgvector', mode: 'keyword' },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });

  it('GET /info includes the authenticated user', async () => {
    const r = await app.inject({ url: '/api/info' });
    const j = r.json() as { user: { email: string } };
    expect(j.user?.email).toBe('local@diluxite');
  });

  it('folders: create, list, rename, move, delete', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name: 'Work' },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const sub = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name: 'Projects', parentId: id },
    });
    expect(sub.statusCode).toBe(201);
    expect(sub.json().parentId).toBe(id);

    const list = await app.inject({ url: `/api/spaces/${spaceId}/folders` });
    expect(list.json()).toHaveLength(2);

    const ren = await app.inject({
      method: 'PUT',
      url: `/api/folders/${id}`,
      payload: { name: 'Work 2026' },
    });
    expect(ren.json().name).toBe('Work 2026');

    const del = await app.inject({ method: 'DELETE', url: `/api/folders/${id}` });
    expect(del.statusCode).toBe(200);
    // cascade removes the sub-folder
    expect((await app.inject({ url: `/api/spaces/${spaceId}/folders` })).json()).toHaveLength(0);
  });

  it('assigns a folder to a note and filters by folder', async () => {
    const folder = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name: 'C' },
    });
    const fid = folder.json().id;
    const create = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'In folder', contentMd: 'x', folderId: fid },
    });
    expect(create.json().folderId).toBe(fid);
    const inside = await app.inject({ url: `/api/spaces/${spaceId}/notes?folder=${fid}` });
    expect((inside.json() as { title: string }[]).map((n) => n.title)).toEqual(['In folder']);
    const root = await app.inject({ url: `/api/spaces/${spaceId}/notes?folder=root` });
    expect((root.json() as unknown[]).length).toBe(2); // Azure + MUG at root
  });

  it('favourite toggle and bulk delete', async () => {
    const fav = await app.inject({
      method: 'PUT',
      url: `/api/notes/${azureId}/favorite`,
      payload: { favorite: true },
    });
    expect(fav.json().favorite).toBe(true);

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/notes/delete-many',
      payload: { ids: [azureId, mugId] },
    });
    expect(bulk.json().deleted).toBe(2);
  });
});
