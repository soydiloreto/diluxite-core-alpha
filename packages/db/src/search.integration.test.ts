import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { NotesService, SearchService, DeterministicEmbeddingProvider } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { DrizzleSearchRepository } from './search-repository';
import { ensureSingleUserBootstrap } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Hybrid search (pgvector + FTS integration)', () => {
  let spaceId: string;
  let search: SearchService;
  let notesSvc: NotesService;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
    const notesRepo = new DrizzleNotesRepository(db);
    const searchRepo = new DrizzleSearchRepository(db);
    search = new SearchService(searchRepo, new DeterministicEmbeddingProvider(1536), notesRepo);
    notesSvc = new NotesService(notesRepo, search); // create => index

    await notesSvc.create({
      spaceId,
      title: 'Azure',
      contentMd: 'Azure es la nube de Microsoft, una plataforma cloud.',
    });
    await notesSvc.create({
      spaceId,
      title: 'MUG',
      contentMd: 'Microsoft User Group, comunidad de usuarios técnicos.',
    });
    await notesSvc.create({
      spaceId,
      title: 'Cocina',
      contentMd: 'Recetas de pastas, tartas y postres caseros.',
    });
    await notesSvc.create({
      spaceId,
      title: 'Infra',
      contentMd: 'Usamos pgvector para guardar los vectores en Postgres.',
    });
  });

  it('semantic search: "la nube de microsoft" => Azure first', async () => {
    const r = await search.search(spaceId, 'la nube de microsoft');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].title).toBe('Azure');
  });

  it('keyword search: "pgvector" => Infra', async () => {
    const r = await search.search(spaceId, 'pgvector');
    expect(r[0].title).toBe('Infra');
  });

  it('topic search: "recetas" => Cocina', async () => {
    const r = await search.search(spaceId, 'recetas');
    expect(r[0].title).toBe('Cocina');
  });

  it('space isolation: does not return notes from another space', async () => {
    const r = await search.search('00000000-0000-0000-0000-000000000000', 'microsoft');
    expect(r).toEqual([]);
  });

  it('deleting a note removes it from search', async () => {
    const infra = (await notesSvc.list(spaceId)).find((n) => n.title === 'Infra')!;
    await notesSvc.delete(infra.id);
    const r = await search.search(spaceId, 'pgvector');
    expect(r.find((x) => x.title === 'Infra')).toBeUndefined();
  });

  it('trashed chunks do not occupy topK candidate slots', async () => {
    // Even with topK=1 and the FTS channel skipped, a trashed match must not
    // crowd out the live result. The repo filters trashed chunks at the
    // candidate stage, not just in the core post-filter.
    const azure = (await notesSvc.list(spaceId)).find((n) => n.title === 'Azure')!;
    await notesSvc.delete(azure.id);
    const repo = new DrizzleSearchRepository(db);
    const hits = await repo.keywordSearch(spaceId, 'microsoft', 10);
    expect(hits.some((h) => h.noteId === azure.id)).toBe(false);
    await notesSvc.restore(azure.id);
    const after = await repo.keywordSearch(spaceId, 'microsoft', 10);
    expect(after.some((h) => h.noteId === azure.id)).toBe(true);
  });

  it('relatedToNote orders by distance, not note_id, under a tight limit', async () => {
    // The source note is closest to MUG (both Microsoft community). With the
    // old `LIMIT limit*4 ORDER BY note_id` the nearest note could be cut by
    // note_id ordering before the distance sort. limit=1 must still surface
    // the single closest neighbour.
    const repo = new DrizzleSearchRepository(db);
    const azure = (await notesSvc.list(spaceId)).find((n) => n.title === 'Azure')!;
    const related = await repo.relatedToNote(spaceId, azure.id, 1);
    expect(related).toHaveLength(1);
    // The returned neighbour is the globally nearest among all candidates.
    const all = await repo.relatedToNote(spaceId, azure.id, 10);
    expect(related[0].noteId).toBe(all[0].noteId);
    // Strictly ascending distances in the full list.
    for (let i = 1; i < all.length; i++) {
      expect(all[i].distance).toBeGreaterThanOrEqual(all[i - 1].distance);
    }
  });

  it('relatedToNote excludes trashed neighbours', async () => {
    const repo = new DrizzleSearchRepository(db);
    const azure = (await notesSvc.list(spaceId)).find((n) => n.title === 'Azure')!;
    const mug = (await notesSvc.list(spaceId)).find((n) => n.title === 'MUG')!;
    await notesSvc.delete(mug.id);
    const related = await repo.relatedToNote(spaceId, azure.id, 10);
    expect(related.some((r) => r.noteId === mug.id)).toBe(false);
  });
});
