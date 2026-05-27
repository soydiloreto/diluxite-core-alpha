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

describe('Tags and links (integration)', () => {
  let spaceId: string;
  let notesSvc: NotesService;
  let tags: DrizzleTagsRepository;
  let links: DrizzleLinksRepository;
  let azureId: string;
  let mugId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
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
        spaceId,
        title: 'Azure',
        contentMd: 'la nube #cloud #azure, ver [[MUG]]',
      })
    ).id;
    mugId = (
      await notesSvc.create({ spaceId, title: 'MUG', contentMd: 'grupo #comunidad' })
    ).id;
  });

  it('indexes tags and lists them with usage count', async () => {
    const list = await tags.listForSpace(spaceId);
    const map = new Map(list.map((t) => [t.tag, t.count]));
    expect(map.get('cloud')).toBe(1);
    expect(map.get('azure')).toBe(1);
    expect(map.get('comunidad')).toBe(1);
  });

  it('filters notes by tag', async () => {
    expect(await tags.noteIdsByTag(spaceId, 'azure')).toEqual([azureId]);
    expect(await tags.noteIdsByTag(spaceId, 'CLOUD')).toEqual([azureId]); // case-insensitive
  });

  it('computes backlinks (Azure links to MUG)', async () => {
    expect(await links.backlinkIds(spaceId, 'MUG')).toEqual([azureId]);
    expect(await links.backlinkIds(spaceId, 'Azure')).toEqual([]);
  });

  it('builds the graph: 2 nodes, 1 edge Azure→MUG', async () => {
    const g = await links.graph(spaceId);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toEqual([{ source: azureId, target: mugId }]);
  });

  it('re-indexing refreshes tags and links', async () => {
    await notesSvc.update(azureId, { contentMd: 'sin tags ni links' });
    expect(await tags.noteIdsByTag(spaceId, 'azure')).toEqual([]);
    expect(await links.backlinkIds(spaceId, 'MUG')).toEqual([]);
  });
});
