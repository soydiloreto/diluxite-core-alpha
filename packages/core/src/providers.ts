// Interfaces enchufables (PRD §11). El Core trae implementaciones deterministas
// para correr y testear sin claves; Cloud enchufa Azure OpenAI / Cohere.

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  /**
   * What this provider is, for an operator to read.
   *
   * Optional so a one-off fake in a test doesn't have to answer it, but every
   * shipped provider does. Without it "which embedder am I running" is a
   * question you can only answer by reading the container's environment —
   * and the answer that matters most, whether it is semantic at all, is not
   * in there at all.
   */
  describe?(): EmbedderDescription;
}

/**
 * A provider, described without its secrets.
 *
 * `apiKey` is deliberately absent and must stay absent: this crosses an HTTP
 * boundary to the admin console.
 */
export interface EmbedderDescription {
  /** `azure`, `ollama` or `local`. */
  provider: string;
  /**
   * Whether the vectors mean anything. The deterministic provider is stable
   * and useful for tests, but it hashes words — semantically, two ways of
   * saying the same thing are as far apart as two unrelated sentences. An
   * install running on it has keyword search wearing a semantic label.
   */
  semantic: boolean;
  dimensions: number;
  /** Deployment or model name. Never a key. */
  model: string | null;
  /** Host only — enough to spot a wrong endpoint, without the path or query. */
  endpoint: string | null;
}

/** Host of a URL, or the raw string if it will not parse. Never throws. */
export function endpointHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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

  describe(): EmbedderDescription {
    return {
      provider: 'local',
      semantic: false,
      dimensions: this.dimensions,
      model: null,
      endpoint: null,
    };
  }

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

  describe(): EmbedderDescription {
    return {
      provider: 'azure',
      semantic: true,
      dimensions: this.dimensions,
      model: this.opts.deployment,
      endpoint: endpointHost(this.opts.endpoint),
    };
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
    const data = (await res.json()) as { data: { embedding: number[]; index?: number }[] };
    // The API doesn't guarantee order: sort by index (stable, so a response
    // without indexes keeps its order) and check cardinality so each vector
    // lines up with its input text.
    if (data.data.length !== texts.length) {
      throw new Error(`Azure embeddings: expected ${texts.length} vectors, got ${data.data.length}`);
    }
    return [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  }
}

export interface OllamaEmbeddingOptions {
  model: string; // ej: nomic-embed-text (768), mxbai-embed-large (1024), all-minilm (384)
  dimensions: number; // depende del modelo: lo declara el caller para evitar sorpresas
  endpoint?: string; // default http://localhost:11434
  fetchImpl?: typeof fetch; // inyectable para tests
  /**
   * Cuánto tiempo Ollama mantiene el modelo cargado en RAM tras la última
   * llamada. Default '24h' para evitar cold-starts de 3-5s cuando el usuario
   * vuelve después de unos minutos. Ollama por default usa 5m, que penaliza
   * cualquier patrón de uso intermitente (justo el de toma-notas).
   * Aceptado por la API: ej. "5m", "1h", "24h", "-1" (forever).
   */
  keepAlive?: string;
}

/** Embeddings locales vía Ollama (sin claves, sin nube). Usa la API /api/embed (batch). */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  constructor(private readonly opts: OllamaEmbeddingOptions) {
    this.dimensions = opts.dimensions;
  }

  describe(): EmbedderDescription {
    return {
      provider: 'ollama',
      semantic: true,
      dimensions: this.dimensions,
      model: this.opts.model,
      endpoint: endpointHost(this.opts.endpoint ?? 'http://localhost:11434'),
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const f = this.opts.fetchImpl ?? fetch;
    const base = (this.opts.endpoint ?? 'http://localhost:11434').replace(/\/$/, '');
    const res = await f(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.opts.model,
        input: texts,
        keep_alive: this.opts.keepAlive ?? '24h',
      }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings HTTP ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    // Guard against partial responses: every input text needs its vector.
    if (data.embeddings.length !== texts.length) {
      throw new Error(`Ollama embeddings: expected ${texts.length} vectors, got ${data.embeddings.length}`);
    }
    return data.embeddings;
  }
}

/**
 * Reranker no-op: preserves the input (RRF) order.
 *
 * No longer the default — `LexicalReranker` is. Kept because it is the honest
 * way to switch reranking OFF, which is what a benchmark comparing against it
 * needs, and what a deployment that distrusts the lexical weights can fall
 * back to.
 */
export class IdentityReranker implements Reranker {
  async rerank(_query: string, docs: RerankDoc[], topK?: number): Promise<Scored[]> {
    const scored = docs.map((d, i) => ({ id: d.id, score: docs.length - i }));
    return topK ? scored.slice(0, topK) : scored;
  }
}
