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

/** Reranker no-op: conserva el orden de entrada (RRF). Cloud usa Cohere/cross-encoder. */
export class IdentityReranker implements Reranker {
  async rerank(_query: string, docs: RerankDoc[], topK?: number): Promise<Scored[]> {
    const scored = docs.map((d, i) => ({ id: d.id, score: docs.length - i }));
    return topK ? scored.slice(0, topK) : scored;
  }
}
