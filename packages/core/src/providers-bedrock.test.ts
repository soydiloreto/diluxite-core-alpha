import { describe, it, expect, vi } from 'vitest';
import { BedrockEmbeddingProvider } from './providers';

/**
 * Bedrock embeddings over the runtime API.
 *
 * Two model families with two different contracts sit behind one provider, so
 * the tests are mostly about not silently returning the wrong number of
 * vectors — the failure that turns into notes indexed against someone else's
 * text without anything erroring.
 */

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('BedrockEmbeddingProvider', () => {
  const base = { region: 'us-east-1', apiKey: 'bedrock-key', dimensions: 1024 };

  it('describes itself without carrying the credential', () => {
    const p = new BedrockEmbeddingProvider({ ...base, model: 'amazon.titan-embed-text-v2:0' });
    const d = p.describe();
    expect(d).toMatchObject({ provider: 'bedrock', semantic: true, dimensions: 1024 });
    expect(JSON.stringify(d)).not.toContain('bedrock-key');
  });

  it('sends the key as a bearer token — no SigV4, no SDK', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ embedding: [0.1, 0.2] }));
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'amazon.titan-embed-text-v2:0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await p.embed(['hola']);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('bedrock-runtime.us-east-1.amazonaws.com');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bedrock-key');
    // No signature headers: that is the whole reason this needs no SDK.
    expect(Object.keys(init.headers as object).join()).not.toMatch(/x-amz-|signature/i);
  });

  it('Titan is called once per text, because that is what it accepts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok({ embedding: [1] }))
      .mockResolvedValueOnce(ok({ embedding: [2] }));
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'amazon.titan-embed-text-v2:0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await p.embed(['uno', 'dos'])).toEqual([[1], [2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('Cohere is called once for the batch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ embeddings: [[1], [2]] }));
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'cohere.embed-multilingual-v3',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await p.embed(['uno', 'dos'])).toEqual([[1], [2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a partial Cohere response rather than returning fewer vectors', async () => {
    // The dangerous one: fewer vectors than texts silently pairs each chunk
    // with the wrong embedding from that point on, and nothing errors.
    const fetchImpl = vi.fn().mockResolvedValue(ok({ embeddings: [[1]] }));
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'cohere.embed-multilingual-v3',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.embed(['uno', 'dos'])).rejects.toThrow(/expected 2 vectors/);
  });

  it('refuses a Titan response with no vector', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ message: 'nope' }));
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'amazon.titan-embed-text-v2:0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.embed(['uno'])).rejects.toThrow(/no vector/i);
  });

  it('surfaces an HTTP failure instead of an empty result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'amazon.titan-embed-text-v2:0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(p.embed(['uno'])).rejects.toThrow(/403/);
  });

  it('does no work for an empty input', async () => {
    const fetchImpl = vi.fn();
    const p = new BedrockEmbeddingProvider({
      ...base,
      model: 'amazon.titan-embed-text-v2:0',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await p.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
