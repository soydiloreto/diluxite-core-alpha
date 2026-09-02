import { describe, it, expect } from 'vitest';
import {
  SearchService,
  DEFAULT_RANKING_WEIGHTS,
  type SearchRepository,
  type ChunkHit,
  type ChunkToIndex,
} from './search';
import { DeterministicEmbeddingProvider } from './providers';
import { InMemoryNotesRepository } from './notes-memory';

class FakeSearchRepo implements SearchRepository {
  /** One organisation, which is what a fake needs to exercise the real path. */
  async orgOfSpace(): Promise<string | null> {
    return 'org-fake';
  }

  indexed: { noteId: string; spaceId: string; chunks: ChunkToIndex[] }[] = [];
  removed: string[] = [];
  tagged: { noteId: string; spaceId: string; tags: string[] }[] = [];
  kw: ChunkHit[] = [];
  vec: ChunkHit[] = [];
  async indexChunks(noteId: string, spaceId: string, chunks: ChunkToIndex[]) {
    this.indexed.push({ noteId, spaceId, chunks });
  }
  async removeChunks(noteId: string) {
    this.removed.push(noteId);
  }
  async setTags(noteId: string, spaceId: string, tags: string[]) {
    this.tagged.push({ noteId, spaceId, tags });
  }
  linked: { noteId: string; spaceId: string; targets: string[] }[] = [];
  async setLinks(noteId: string, spaceId: string, targets: string[]) {
    this.linked.push({ noteId, spaceId, targets });
  }
  tagsRemoved: string[] = [];
  async removeTags(noteId: string) {
    this.tagsRemoved.push(noteId);
  }
  linksRemoved: string[] = [];
  async removeLinks(noteId: string) {
    this.linksRemoved.push(noteId);
  }
  async keywordSearch() {
    return this.kw;
  }
  async vectorSearch() {
    return this.vec;
  }
  async relatedToNote() {
    return [];
  }
}

describe('SearchService (unit, fake repo)', () => {
  it('fuses keyword+vector with RRF and dedupes per note', async () => {
    const notes = new InMemoryNotesRepository();
    const n1 = await notes.create({ spaceId: 's', title: 'Azure', contentMd: 'la nube' });
    const n2 = await notes.create({ spaceId: 's', title: 'MUG', contentMd: 'grupo' });
    const n3 = await notes.create({ spaceId: 's', title: 'Fruta', contentMd: 'banana' });

    const repo = new FakeSearchRepo();
    repo.kw = [
      { id: 'c1', noteId: n1.id, text: 'la nube' },
      { id: 'c2', noteId: n2.id, text: 'grupo' },
    ];
    repo.vec = [
      { id: 'c2', noteId: n2.id, text: 'grupo' }, // present in both lists => wins
      { id: 'c3', noteId: n3.id, text: 'banana' },
    ];

    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const r = await svc.search('s', 'something');
    expect(r.map((x) => x.title)).toEqual(['MUG', 'Azure', 'Fruta']);
    expect(r[0].snippet).toBe('grupo');
  });

  it('remove() wipes chunks, tags AND links (symmetric soft delete)', async () => {
    const notes = new InMemoryNotesRepository();
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    await svc.remove('note-1');
    expect(repo.removed).toEqual(['note-1']);
    expect(repo.tagsRemoved).toEqual(['note-1']);
    expect(repo.linksRemoved).toEqual(['note-1']);
  });

  it('keyword uses only the keyword channel; semantic only vector; hybrid both', async () => {
    const notes = new InMemoryNotesRepository();
    const a = await notes.create({ spaceId: 's', title: 'A', contentMd: 'a' });
    const b = await notes.create({ spaceId: 's', title: 'B', contentMd: 'b' });
    const repo = new FakeSearchRepo();
    repo.kw = [{ id: 'c1', noteId: a.id, text: 'a' }];
    repo.vec = [{ id: 'c2', noteId: b.id, text: 'b' }];
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);

    expect((await svc.search('s', 'q', 5, 'keyword')).map((r) => r.title)).toEqual(['A']);
    expect((await svc.search('s', 'q', 5, 'semantic')).map((r) => r.title)).toEqual(['B']);
    const hybrid = (await svc.search('s', 'q', 5, 'hybrid')).map((r) => r.title);
    expect(hybrid).toContain('A');
    expect(hybrid).toContain('B');
  });

  it('empty query => []', async () => {
    const svc = new SearchService(new FakeSearchRepo(), new DeterministicEmbeddingProvider(1536), new InMemoryNotesRepository());
    expect(await svc.search('s', '   ')).toEqual([]);
  });

  it('index() chunkifies, embeds (1536 dims) and persists', async () => {
    const notes = new InMemoryNotesRepository();
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const n = await notes.create({ spaceId: 's', title: 'Hola', contentMd: 'mundo' });
    await svc.index(n);
    expect(repo.indexed).toHaveLength(1);
    expect(repo.indexed[0].noteId).toBe(n.id);
    expect(repo.indexed[0].chunks.length).toBeGreaterThanOrEqual(1);
    expect(repo.indexed[0].chunks[0].embedding).toHaveLength(1536);
  });

  it('index() extracts and persists the note tags', async () => {
    const notes = new InMemoryNotesRepository();
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const n = await notes.create({ spaceId: 's', title: 'Infra', contentMd: 'usa #azure y #mcp' });
    await svc.index(n);
    expect(repo.tagged).toHaveLength(1);
    expect(repo.tagged[0].tags).toEqual(['azure', 'mcp']);
  });

  it('an archived note still answers, marked, and ranked below a live one', async () => {
    const notes = new InMemoryNotesRepository();
    // The archived one wins the fusion outright (it is in both channels), so
    // if it still lands second the demotion — and only the demotion — did it.
    const old = await notes.create({ spaceId: 's', title: 'Old', contentMd: 'azure viejo' });
    const live = await notes.create({ spaceId: 's', title: 'Live', contentMd: 'azure hoy' });
    await notes.setArchived(old.id, true);

    const repo = new FakeSearchRepo();
    repo.kw = [
      { id: 'c1', noteId: old.id, text: 'azure viejo' },
      { id: 'c2', noteId: live.id, text: 'azure hoy' },
    ];
    repo.vec = [{ id: 'c1', noteId: old.id, text: 'azure viejo' }];

    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const r = await svc.search('s', 'azure');

    expect(r.map((x) => x.title)).toEqual(['Live', 'Old']);
    expect(r.find((x) => x.title === 'Old')?.archived).toBe(true);
    // A live result carries no flag at all — the shape every caller already reads.
    expect(r.find((x) => x.title === 'Live')).not.toHaveProperty('archived');
  });

  it('archiving never drops a note out of the answer', async () => {
    const notes = new InMemoryNotesRepository();
    const only = await notes.create({ spaceId: 's', title: 'Only', contentMd: 'azure' });
    await notes.setArchived(only.id, true);

    const repo = new FakeSearchRepo();
    repo.kw = [{ id: 'c1', noteId: only.id, text: 'azure' }];

    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const r = await svc.search('s', 'azure');
    expect(r.map((x) => x.title)).toEqual(['Only']);
  });

  describe('standing weighs on the order (ADR-002 axis three)', () => {
    /** A validity source with whatever standings the test declares. */
    function standings(map: Record<string, { rank: 'preferred' | 'normal' | 'deprecated'; validTo?: Date }>) {
      return {
        async standingForNotes(ids: string[]) {
          const out = new Map<string, { rank: 'preferred' | 'normal' | 'deprecated'; validTo: Date | null }>();
          for (const id of ids) {
            const s = map[id];
            if (s) out.set(id, { rank: s.rank, validTo: s.validTo ?? null });
          }
          return out;
        },
      };
    }

    /** Two notes, the first winning the fusion outright. */
    async function twoNotes() {
      const notes = new InMemoryNotesRepository();
      const first = await notes.create({ spaceId: 's', title: 'First', contentMd: 'azure uno' });
      const second = await notes.create({ spaceId: 's', title: 'Second', contentMd: 'azure dos' });
      const repo = new FakeSearchRepo();
      repo.kw = [
        { id: 'c1', noteId: first.id, text: 'azure uno' },
        { id: 'c2', noteId: second.id, text: 'azure dos' },
      ];
      repo.vec = [{ id: 'c1', noteId: first.id, text: 'azure uno' }];
      return { notes, repo, first, second };
    }

    it('a superseded note is answered, marked, and ranked below a live one', async () => {
      const { notes, repo, first } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        validity: standings({ [first.id]: { rank: 'deprecated' } }),
      });
      const r = await svc.search('s', 'azure');
      expect(r.map((x) => x.title)).toEqual(['Second', 'First']);
      expect(r.find((x) => x.title === 'First')?.expired).toBe(true);
    });

    it('an expiry still in the future does not demote anything', async () => {
      const { notes, repo, first } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        validity: standings({
          [first.id]: { rank: 'normal', validTo: new Date(Date.now() + 864e5) },
        }),
      });
      const r = await svc.search('s', 'azure');
      // Current until the date arrives — that is the whole difference between
      // an expiry and a supersession.
      expect(r.map((x) => x.title)).toEqual(['First', 'Second']);
      expect(r[0].expired).toBeUndefined();
    });

    it('an expiry in the past demotes and marks', async () => {
      const { notes, repo, first } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        validity: standings({
          [first.id]: { rank: 'normal', validTo: new Date(Date.now() - 864e5) },
        }),
      });
      const r = await svc.search('s', 'azure');
      expect(r.map((x) => x.title)).toEqual(['Second', 'First']);
      expect(r.find((x) => x.title === 'First')?.expired).toBe(true);
    });

    it('a signed note is boosted and marked as confirmed', async () => {
      const { notes, repo, second } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        validity: standings({ [second.id]: { rank: 'preferred' } }),
      });
      const r = await svc.search('s', 'azure');
      expect(r[0].title).toBe('Second');
      expect(r[0].confirmed).toBe(true);
    });

    it('hideExpired removes them, and it is off by default', async () => {
      const { notes, repo, first } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        validity: standings({ [first.id]: { rank: 'deprecated' } }),
      });
      expect((await svc.search('s', 'azure')).map((x) => x.title)).toEqual(['Second', 'First']);
      const hidden = await svc.search('s', 'azure', 5, 'hybrid', {
        ...DEFAULT_RANKING_WEIGHTS,
        hideExpired: true,
      });
      expect(hidden.map((x) => x.title)).toEqual(['Second']);
    });

    it('without a validity source the order is exactly what it was', async () => {
      const { notes, repo } = await twoNotes();
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
      expect((await svc.search('s', 'azure')).map((x) => x.title)).toEqual(['First', 'Second']);
    });
  });

  describe('usage counting (migration 0038)', () => {
    it('counts the page of results in ONE call, with their space', async () => {
      const notes = new InMemoryNotesRepository();
      const a = await notes.create({ spaceId: 's', title: 'A', contentMd: 'azure' });
      const b = await notes.create({ spaceId: 's', title: 'B', contentMd: 'azure dos' });
      const repo = new FakeSearchRepo();
      repo.kw = [
        { id: 'c1', noteId: a.id, text: 'azure' },
        { id: 'c2', noteId: b.id, text: 'azure dos' },
      ];
      const calls: { ids: string[]; spaceId: string }[] = [];
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        usage: {
          async recordUse(ids, spaceId) {
            calls.push({ ids, spaceId });
          },
        },
      });
      await svc.search('s', 'azure');
      // One write for the whole page, never one per hit.
      expect(calls).toHaveLength(1);
      expect(calls[0].ids.sort()).toEqual([a.id, b.id].sort());
      expect(calls[0].spaceId).toBe('s');
    });

    it('a failure to count never fails the search', async () => {
      const notes = new InMemoryNotesRepository();
      const a = await notes.create({ spaceId: 's', title: 'A', contentMd: 'azure' });
      const repo = new FakeSearchRepo();
      repo.kw = [{ id: 'c1', noteId: a.id, text: 'azure' }];
      const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes, {
        usage: {
          async recordUse() {
            throw new Error('counter is down');
          },
        },
      });
      // Bookkeeping that swallows somebody's answer is a bad trade.
      expect((await svc.search('s', 'azure')).map((r) => r.title)).toEqual(['A']);
    });

    it('counts nothing when the search found nothing', async () => {
      const repo = new FakeSearchRepo();
      let called = 0;
      const svc = new SearchService(
        repo,
        new DeterministicEmbeddingProvider(1536),
        new InMemoryNotesRepository(),
        {
          usage: {
            async recordUse() {
              called++;
            },
          },
        },
      );
      await svc.search('s', 'nada');
      expect(called).toBe(0);
    });
  });

  it('quotes the passage that matched, not the start of the note', async () => {
    const notes = new InMemoryNotesRepository();
    const n = await notes.create({
      spaceId: 's',
      title: 'Larga',
      contentMd: 'primer párrafo, irrelevante.\n\nel umbral de fraude es 3%.',
    });
    const repo = new FakeSearchRepo();
    repo.kw = [{ id: 'c2', noteId: n.id, text: 'el umbral de fraude es 3%.' }];

    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const [hit] = await svc.search('s', 'umbral');
    // Quoting the opening makes the reader open the note to find out why it
    // came back at all.
    expect(hit.snippet).toBe('el umbral de fraude es 3%.');
  });

  it('remove() drops the chunks of a note', async () => {
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), new InMemoryNotesRepository());
    await svc.remove('note-x');
    expect(repo.removed).toEqual(['note-x']);
  });
});
