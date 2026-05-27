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
});
