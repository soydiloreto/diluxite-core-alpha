// Interfaces enchufables (PRD §11). El Core trae implementaciones deterministas
// para correr y testear sin claves; Cloud enchufa Azure OpenAI / Cohere.

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface RerankDoc {
  id: string;
  text: string;
}

export interface Scored {
  id: string;
  score: number;
}

export interface Reranker {
  rerank(query: string, docs: RerankDoc[], topK?: number): Promise<Scored[]>;
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Embeddings deterministas: cada palabra genera un vector denso pseudo-aleatorio
 * (estable por hashing), y la nota es la suma normalizada. No es semántico real
 * (eso lo da Azure OpenAI / un modelo local), pero es estable y hace que textos
 * con palabras compartidas queden más cerca: ideal para tests del pipeline.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(public readonly dimensions = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private tokenVector(token: string): number[] {
    const v = new Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      v[i] = (fnv1a(`${token}:${i}`) / 0xffffffff) * 2 - 1; // [-1, 1]
    }
    return v;
  }

  private vector(text: string): number[] {
    const v = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
    for (const tok of tokens) {
      const tv = this.tokenVector(tok);
      for (let i = 0; i < this.dimensions; i++) v[i] += tv[i];
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

export interface AzureEmbeddingOptions {
  endpoint: string; // https://<recurso>.openai.azure.com
  apiKey: string;
  deployment: string; // nombre del deployment (ej: text-embedding-3-large)
  dimensions?: number; // default 1536 (≤ 2000 para indexar en Azure pgvector)
  apiVersion?: string;
  fetchImpl?: typeof fetch; // inyectable para tests
}

/** Embeddings reales vía Azure OpenAI. Se usa en self-host/Cloud cuando hay credenciales. */
export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  constructor(private readonly opts: AzureEmbeddingOptions) {
    this.dimensions = opts.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const f = this.opts.fetchImpl ?? fetch;
    const version = this.opts.apiVersion ?? '2024-02-01';
    const url = `${this.opts.endpoint.replace(/\/$/, '')}/openai/deployments/${this.opts.deployment}/embeddings?api-version=${version}`;
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': this.opts.apiKey },
      body: JSON.stringify({ input: texts, dimensions: this.dimensions }),
    });
    if (!res.ok) throw new Error(`Azure embeddings HTTP ${res.status}`);
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  }
}

/** Reranker no-op: conserva el orden de entrada (RRF). Cloud usa Cohere/cross-encoder. */
export class IdentityReranker implements Reranker {
  async rerank(_query: string, docs: RerankDoc[], topK?: number): Promise<Scored[]> {
    const scored = docs.map((d, i) => ({ id: d.id, score: docs.length - i }));
    return topK ? scored.slice(0, topK) : scored;
  }
}
