import { describe, it, expect, beforeEach } from 'vitest';
import { NotesService, type Note, type NoteIndexer } from './notes';
import { InMemoryNotesRepository } from './notes-memory';

const SPACE = 'space-1';

describe('NotesService', () => {
  let clock: number;
  let repo: InMemoryNotesRepository;
  let svc: NotesService;
  let indexed: Note[];
  let removed: string[];
  let indexer: NoteIndexer;

  beforeEach(() => {
    clock = 1000;
    repo = new InMemoryNotesRepository(() => new Date(clock));
    indexed = [];
    removed = [];
    indexer = {
      index: async (n) => void indexed.push(n),
      remove: async (id) => void removed.push(id),
    };
    svc = new NotesService(repo, indexer);
  });

  it('creates a note with id and timestamps, and indexes it', async () => {
    const n = await svc.create({ spaceId: SPACE, title: 'Hola', contentMd: 'mundo' });
    expect(n.id).toBeTruthy();
    expect(n.title).toBe('Hola');
    expect(n.createdAt.getTime()).toBe(1000);
    expect(n.updatedAt.getTime()).toBe(1000);
    expect(indexed).toHaveLength(1);
    expect(indexed[0].id).toBe(n.id);
  });

  it('reads and lists notes in the space', async () => {
    const a = await svc.create({ spaceId: SPACE, title: 'A' });
    await svc.create({ spaceId: 'other', title: 'B' });
    expect((await svc.get(a.id))?.title).toBe('A');
    const list = await svc.list(SPACE);
    expect(list.map((n) => n.title)).toEqual(['A']);
  });

  it('updates content, bumps updatedAt and reindexes', async () => {
    const n = await svc.create({ spaceId: SPACE, title: 'T', contentMd: 'v1' });
    clock = 5000;
    const upd = await svc.update(n.id, { contentMd: 'v2' });
    expect(upd?.contentMd).toBe('v2');
    expect(upd?.updatedAt.getTime()).toBe(5000);
    expect(upd?.createdAt.getTime()).toBe(1000);
    expect(indexed).toHaveLength(2); // create + update
  });

  it('deletes and notifies the indexer', async () => {
    const n = await svc.create({ spaceId: SPACE, title: 'X' });
    expect(await svc.delete(n.id)).toBe(true);
    expect(await svc.get(n.id)).toBeNull();
    expect(removed).toEqual([n.id]);
    expect(await svc.delete('missing')).toBe(false);
  });

  it('openOrCreate creates when missing and reuses when present', async () => {
    const first = await svc.openOrCreate(SPACE, 'MUG');
    expect(first.contentMd).toContain('# MUG');
    const second = await svc.openOrCreate(SPACE, 'MUG');
    expect(second.id).toBe(first.id);
    expect((await svc.list(SPACE)).length).toBe(1);
  });

  it('marks and unmarks as favourite', async () => {
    const n = await svc.create({ spaceId: SPACE, title: 'F' });
    expect(n.favorite).toBe(false);
    const fav = await svc.setFavorite(n.id, true);
    expect(fav?.favorite).toBe(true);
  });

  it('deletes many notes at once', async () => {
    const a = await svc.create({ spaceId: SPACE, title: 'A' });
    const b = await svc.create({ spaceId: SPACE, title: 'B' });
    expect(await svc.deleteManyIds([a.id, b.id, 'missing'])).toBe(2);
    expect((await svc.list(SPACE)).length).toBe(0);
  });

  it('extracts outgoing wikilinks from a note', async () => {
    const n = await svc.create({
      spaceId: SPACE,
      title: 'Ideas',
      contentMd: 'see [[ConoSurTech]] and [[MUG|the group]] and [[ConoSurTech]]',
    });
    expect(svc.outgoingLinks(n)).toEqual(['ConoSurTech', 'MUG']);
  });
});
