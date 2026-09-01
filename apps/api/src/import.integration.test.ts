import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { zipSync, strToU8 } from 'fflate';
import { buildTestApp } from '../test/helpers';

/**
 * Importing a vault.
 *
 * The parsing has its own unit tests (`import-markdown.test.ts`); what this
 * asks is whether the notes and folders actually land — and what the endpoint
 * does about the two things that go wrong in a real migration: a title that is
 * already taken, and running the same import twice.
 */

const zipOf = (files: Record<string, string>): string =>
  Buffer.from(
    zipSync(Object.fromEntries(Object.entries(files).map(([p, c]) => [p, strToU8(c)]))),
  ).toString('base64');

describe('POST /api/spaces/:spaceId/import', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  const importZip = (files: Record<string, string>, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/import`,
      payload: { zipBase64: zipOf(files), ...extra },
    });

  const notes = async () => {
    const r = await app.inject({ url: `/api/spaces/${spaceId}/notes` });
    expect(r.statusCode).toBe(200);
    return r.json() as { id: string; title: string; folderId: string | null }[];
  };

  it('creates the notes and the folder tree they lived in', async () => {
    const res = await importZip({
      'Vault/Diario.md': 'Hoy escribí.',
      'Vault/Proyectos/Diluxite.md': 'Sobre el proyecto, con [[Diario]].',
      'Vault/Proyectos/Internos/Ideas.md': 'Una idea.',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true, created: 3 });

    const titles = (await notes()).map((n) => n.title).sort();
    expect(titles).toEqual(['Diario', 'Diluxite', 'Ideas']);

    const folders = await app.inject({ url: `/api/spaces/${spaceId}/folders` });
    const names = (folders.json() as { name: string }[]).map((f) => f.name).sort();
    expect(names).toEqual(['Internos', 'Proyectos']);
  });

  it('the imported notes are searchable, so they went through indexing', async () => {
    // A note created without indexing is invisible to the product's main
    // feature — an import that skipped it would look complete and not be.
    await importZip({
      'V/Uno.md': 'La búsqueda combina BM25 con pgvector.',
      'V/Dos.md': 'Otra cosa distinta.',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/search',
      payload: { query: 'pgvector', spaceId, topK: 5 },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { title: string }[]).map((x) => x.title)).toContain('Uno');
  });

  it('dryRun says what it would do and writes nothing', async () => {
    const res = await importZip(
      { 'V/Uno.md': 'a', 'V/imagen.png': 'binario', 'V/Dos.md': 'b' },
      { dryRun: true },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      applied: boolean;
      notes: { title: string }[];
      skipped: { path: string }[];
    };
    expect(body.applied).toBe(false);
    expect(body.notes.map((n) => n.title)).toEqual(['Uno', 'Dos']);
    expect(body.skipped.map((s) => s.path)).toEqual(['V/imagen.png']);
    expect(await notes()).toHaveLength(0);
  });

  it('does not overwrite a note that already has that title', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Diario', contentMd: 'lo que ya estaba' },
    });
    expect(created.statusCode).toBe(201);

    const res = await importZip({ 'V/Diario.md': 'lo que vino del vault', 'V/Otra.md': 'x' });
    expect(res.json()).toMatchObject({ created: 1 });
    expect((res.json() as { skipped: { reason: string }[] }).skipped[0].reason).toMatch(
      /already exists/,
    );

    const mine = (await notes()).find((n) => n.title === 'Diario')!;
    const full = await app.inject({ url: `/api/notes/${mine.id}` });
    expect((full.json() as { contentMd: string }).contentMd).toBe('lo que ya estaba');
  });

  it('running the same import twice creates nothing the second time', async () => {
    const files = { 'V/Uno.md': 'a', 'V/Dos.md': 'b' };
    expect((await importZip(files)).json()).toMatchObject({ created: 2 });
    expect((await importZip(files)).json()).toMatchObject({ created: 0 });
    expect(await notes()).toHaveLength(2);
  });

  it('refuses what is not a ZIP, and says so', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/import`,
      payload: { zipBase64: Buffer.from('esto no es un zip').toString('base64') },
    });
    expect(res.statusCode).toBe(400);
    const empty = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/import`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});
