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

  it('openOrCreate files a new note in the given folder', async () => {
    const n = await svc.openOrCreate(SPACE, 'Daily 2026-08-24', 'folder-1');
    expect(n.folderId).toBe('folder-1');
  });

  it('openOrCreate leaves an existing note where it already lives', async () => {
    const first = await svc.openOrCreate(SPACE, 'Daily 2026-08-24');
    expect(first.folderId).toBeNull();

    // Writing to it again with a folder must not move it: the user may have
    // filed it somewhere on purpose.
    const again = await svc.openOrCreate(SPACE, 'Daily 2026-08-24', 'folder-1');
    expect(again.id).toBe(first.id);
    expect(again.folderId).toBeNull();
  });
});

describe('NotesService — version history (reads + restore; RECORDING lives in the db repo)', () => {
  // The service does not snapshot on update — the Drizzle repository does,
  // inside its own `update`, because the collab mirror writes through the
  // repo directly and a service-level snapshot would miss it. Here we cover
  // what the service DOES own: listing, fetching, and restore semantics.
  function memoryVersions(seed: import('./notes').NoteVersion[] = []) {
    const rows = [...seed];
    const repo: import('./notes').NoteVersionsRepository = {
      async record(prev) {
        const v = {
          id: `v${rows.length + 1}`,
          noteId: prev.id,
          spaceId: prev.spaceId,
          title: prev.title,
          contentMd: prev.contentMd,
          createdAt: new Date(rows.length + 1),
        };
        rows.push(v);
        return v;
      },
      async listForNote(noteId, limit = 50) {
        return rows.filter((v) => v.noteId === noteId).reverse().slice(0, limit);
      },
      async findById(id) {
        return rows.find((v) => v.id === id) ?? null;
      },
    };
    return { repo, rows };
  }

  function version(noteId: string, id: string, contentMd: string): import('./notes').NoteVersion {
    return { id, noteId, spaceId: SPACE, title: 'T', contentMd, createdAt: new Date(1) };
  }

  it('listVersions omits the content; getVersion carries it', async () => {
    const svc0 = new NotesService(new InMemoryNotesRepository(() => new Date(0)));
    const n = await svc0.create({ spaceId: SPACE, title: 'T', contentMd: 'v2' });
    const { repo: versions } = memoryVersions([version(n.id, 'v1', 'v1')]);
    const svc = new NotesService(new InMemoryNotesRepository(() => new Date(0)), undefined, versions);
    const [meta] = await svc.listVersions(n.id);
    expect(meta.id).toBe('v1');
    expect('contentMd' in meta).toBe(false);
    expect((await svc.getVersion('v1'))?.contentMd).toBe('v1');
  });

  it('restore writes the old content back through update', async () => {
    const repo = new InMemoryNotesRepository(() => new Date(0));
    const svc0 = new NotesService(repo);
    const n = await svc0.create({ spaceId: SPACE, title: 'T', contentMd: 'v2' });
    const { repo: versions } = memoryVersions([version(n.id, 'v1', 'v1')]);
    const svc = new NotesService(repo, undefined, versions);
    const restored = await svc.restoreVersion(n.id, 'v1');
    expect(restored?.contentMd).toBe('v1');
    expect((await svc.get(n.id))?.contentMd).toBe('v1');
  });

  it('restoreVersion refuses a version belonging to another note', async () => {
    const repo = new InMemoryNotesRepository(() => new Date(0));
    const svc0 = new NotesService(repo);
    const a = await svc0.create({ spaceId: SPACE, title: 'A', contentMd: 'a2' });
    const b = await svc0.create({ spaceId: SPACE, title: 'B', contentMd: 'b1' });
    const { repo: versions } = memoryVersions([version(a.id, 'v1', 'a1')]);
    const svc = new NotesService(repo, undefined, versions);
    expect(await svc.restoreVersion(b.id, 'v1')).toBeNull();
    expect((await svc.get(b.id))?.contentMd).toBe('b1');
  });

  it('without a versions repository, history is honestly empty', async () => {
    const svc = new NotesService(new InMemoryNotesRepository(() => new Date(0)));
    const n = await svc.create({ spaceId: SPACE, title: 'T', contentMd: 'v1' });
    await svc.update(n.id, { contentMd: 'v2' });
    expect(await svc.listVersions(n.id)).toEqual([]);
    expect(await svc.getVersion('nope')).toBeNull();
    expect(await svc.restoreVersion(n.id, 'nope')).toBeNull();
  });
});
