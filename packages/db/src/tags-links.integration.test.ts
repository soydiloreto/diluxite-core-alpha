import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { DeterministicEmbeddingProvider, NotesService, SearchService } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { DrizzleSearchRepository } from './search-repository';
import { DrizzleTagsRepository } from './tags-repository';
import { DrizzleLinksRepository } from './links-repository';
import { ensureSingleUserBootstrap } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Tags y links (integración)', () => {
  let espacioId: string;
  let notesSvc: NotesService;
  let tags: DrizzleTagsRepository;
  let links: DrizzleLinksRepository;
  let azureId: string;
  let mugId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ espacioId } = await ensureSingleUserBootstrap(db));
    const notesRepo = new DrizzleNotesRepository(db);
    const search = new SearchService(
      new DrizzleSearchRepository(db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    notesSvc = new NotesService(notesRepo, search);
    tags = new DrizzleTagsRepository(db);
    links = new DrizzleLinksRepository(db);

    azureId = (
      await notesSvc.create({
        espacioId,
        titulo: 'Azure',
        contenidoMd: 'la nube #cloud #azure, ver [[MUG]]',
      })
    ).id;
    mugId = (
      await notesSvc.create({ espacioId, titulo: 'MUG', contenidoMd: 'grupo #comunidad' })
    ).id;
  });

  it('indexa tags y los lista con conteo', async () => {
    const list = await tags.listForSpace(espacioId);
    const map = new Map(list.map((t) => [t.tag, t.count]));
    expect(map.get('cloud')).toBe(1);
    expect(map.get('azure')).toBe(1);
    expect(map.get('comunidad')).toBe(1);
  });

  it('filtra notas por tag', async () => {
    expect(await tags.noteIdsByTag(espacioId, 'azure')).toEqual([azureId]);
    expect(await tags.noteIdsByTag(espacioId, 'CLOUD')).toEqual([azureId]); // case-insensitive
  });

  it('calcula backlinks (Azure enlaza a MUG)', async () => {
    expect(await links.backlinkIds(espacioId, 'MUG')).toEqual([azureId]);
    expect(await links.backlinkIds(espacioId, 'Azure')).toEqual([]);
  });

  it('arma el grafo: 2 nodos, 1 arista Azure→MUG', async () => {
    const g = await links.graph(espacioId);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ source: azureId, target: mugId }]);
  });

  it('re-indexar actualiza tags y links', async () => {
    await notesSvc.update(azureId, { contenidoMd: 'sin tags ni links' });
    expect(await tags.noteIdsByTag(espacioId, 'azure')).toEqual([]);
    expect(await links.backlinkIds(espacioId, 'MUG')).toEqual([]);
  });
});
