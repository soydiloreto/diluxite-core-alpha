import { describe, it, expect } from 'vitest';
import { SearchService, type SearchRepository, type ChunkHit, type ChunkToIndex } from './search';
import { DeterministicEmbeddingProvider } from './providers';
import { InMemoryNotesRepository } from './notes-memory';

class FakeSearchRepo implements SearchRepository {
  indexed: { notaId: string; espacioId: string; chunks: ChunkToIndex[] }[] = [];
  removed: string[] = [];
  tagged: { notaId: string; espacioId: string; tags: string[] }[] = [];
  kw: ChunkHit[] = [];
  vec: ChunkHit[] = [];
  async indexChunks(notaId: string, espacioId: string, chunks: ChunkToIndex[]) {
    this.indexed.push({ notaId, espacioId, chunks });
  }
  async removeChunks(notaId: string) {
    this.removed.push(notaId);
  }
  async setTags(notaId: string, espacioId: string, tags: string[]) {
    this.tagged.push({ notaId, espacioId, tags });
  }
  linked: { notaId: string; espacioId: string; targets: string[] }[] = [];
  async setLinks(notaId: string, espacioId: string, targets: string[]) {
    this.linked.push({ notaId, espacioId, targets });
  }
  async keywordSearch() {
    return this.kw;
  }
  async vectorSearch() {
    return this.vec;
  }
}

describe('SearchService (unidad, repo fake)', () => {
  it('fusiona keyword+vector con RRF y deduplica por nota', async () => {
    const notes = new InMemoryNotesRepository();
    const n1 = await notes.create({ espacioId: 's', titulo: 'Azure', contenidoMd: 'la nube' });
    const n2 = await notes.create({ espacioId: 's', titulo: 'MUG', contenidoMd: 'grupo' });
    const n3 = await notes.create({ espacioId: 's', titulo: 'Fruta', contenidoMd: 'banana' });

    const repo = new FakeSearchRepo();
    repo.kw = [
      { id: 'c1', notaId: n1.id, texto: 'la nube' },
      { id: 'c2', notaId: n2.id, texto: 'grupo' },
    ];
    repo.vec = [
      { id: 'c2', notaId: n2.id, texto: 'grupo' }, // en ambas listas => gana
      { id: 'c3', notaId: n3.id, texto: 'banana' },
    ];

    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const r = await svc.search('s', 'algo');
    expect(r.map((x) => x.titulo)).toEqual(['MUG', 'Azure', 'Fruta']);
    expect(r[0].snippet).toBe('grupo');
  });

  it('query vacía => []', async () => {
    const svc = new SearchService(new FakeSearchRepo(), new DeterministicEmbeddingProvider(1536), new InMemoryNotesRepository());
    expect(await svc.search('s', '   ')).toEqual([]);
  });

  it('index() chunkifica, embebe (1536 dims) y persiste', async () => {
    const notes = new InMemoryNotesRepository();
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const n = await notes.create({ espacioId: 's', titulo: 'Hola', contenidoMd: 'mundo' });
    await svc.index(n);
    expect(repo.indexed).toHaveLength(1);
    expect(repo.indexed[0].notaId).toBe(n.id);
    expect(repo.indexed[0].chunks.length).toBeGreaterThanOrEqual(1);
    expect(repo.indexed[0].chunks[0].embedding).toHaveLength(1536);
  });

  it('index() extrae y persiste los tags de la nota', async () => {
    const notes = new InMemoryNotesRepository();
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), notes);
    const n = await notes.create({ espacioId: 's', titulo: 'Infra', contenidoMd: 'uso #azure y #mcp' });
    await svc.index(n);
    expect(repo.tagged).toHaveLength(1);
    expect(repo.tagged[0].tags).toEqual(['azure', 'mcp']);
  });

  it('remove() borra los chunks de la nota', async () => {
    const repo = new FakeSearchRepo();
    const svc = new SearchService(repo, new DeterministicEmbeddingProvider(1536), new InMemoryNotesRepository());
    await svc.remove('nota-x');
    expect(repo.removed).toEqual(['nota-x']);
  });
});
