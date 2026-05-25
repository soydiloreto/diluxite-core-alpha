import { describe, it, expect } from 'vitest';
import {
  AzureOpenAIEmbeddingProvider,
  DeterministicEmbeddingProvider,
  IdentityReranker,
} from './providers';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectores ya normalizados (L2)
}

describe('DeterministicEmbeddingProvider', () => {
  const emb = new DeterministicEmbeddingProvider();

  it('respeta la dimensión configurada', async () => {
    expect(emb.dimensions).toBe(64);
    const [v] = await emb.embed(['hola']);
    expect(v).toHaveLength(64);
  });

  it('es determinista: mismo texto => mismo vector', async () => {
    const [a] = await emb.embed(['Azure es la nube de Microsoft']);
    const [b] = await emb.embed(['Azure es la nube de Microsoft']);
    expect(a).toEqual(b);
  });

  it('textos que comparten palabras son más similares que los no relacionados', async () => {
    const [azure1, azure2, fruta] = await emb.embed([
      'Azure nube de Microsoft',
      'Azure servicios cloud',
      'banana naranja fruta',
    ]);
    expect(cosine(azure1, azure2)).toBeGreaterThan(cosine(azure1, fruta));
  });
});

describe('AzureOpenAIEmbeddingProvider', () => {
  it('llama al endpoint de Azure y devuelve los vectores', async () => {
    let calledUrl = '';
    let calledBody: unknown;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }),
      };
    }) as unknown as typeof fetch;

    const provider = new AzureOpenAIEmbeddingProvider({
      endpoint: 'https://r.openai.azure.com/',
      apiKey: 'k',
      deployment: 'text-embedding-3-large',
      dimensions: 2,
      fetchImpl: fakeFetch,
    });

    const out = await provider.embed(['a', 'b']);
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(calledUrl).toContain('/openai/deployments/text-embedding-3-large/embeddings');
    expect(calledBody).toMatchObject({ input: ['a', 'b'], dimensions: 2 });
  });

  it('lanza si Azure responde error', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    const provider = new AzureOpenAIEmbeddingProvider({
      endpoint: 'https://r.openai.azure.com',
      apiKey: 'k',
      deployment: 'd',
      fetchImpl: fakeFetch,
    });
    await expect(provider.embed(['x'])).rejects.toThrow('401');
  });
});

describe('IdentityReranker', () => {
  const rr = new IdentityReranker();
  const docs = [
    { id: '1', text: 'uno' },
    { id: '2', text: 'dos' },
    { id: '3', text: 'tres' },
  ];

  it('preserva el orden de entrada', async () => {
    const r = await rr.rerank('q', docs);
    expect(r.map((x) => x.id)).toEqual(['1', '2', '3']);
  });

  it('recorta a topK', async () => {
    const r = await rr.rerank('q', docs, 2);
    expect(r.map((x) => x.id)).toEqual(['1', '2']);
  });
});
