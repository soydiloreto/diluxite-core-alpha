import { describe, it, expect } from 'vitest';
import { SearchService, type SearchRepository, type ChunkHit, type ChunkToIndex } from './search';
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

  it('remove() drops the chunks of a note', async () => {
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), new InMemoryNotesRepository());
    await svc.remove('note-x');
    expect(repo.removed).toEqual(['note-x']);
  });
});
