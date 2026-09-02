import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatibleGenerationProvider, DRAFT_PASSAGE_CHARS } from './generation';

function answering(content: string | null, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as typeof fetch;
}

const make = (fetchImpl: typeof fetch) =>
  new OpenAICompatibleGenerationProvider({
    endpoint: 'https://model.example/v1/chat/completions',
    model: 'test',
    apiKey: 'k',
    fetchImpl,
  });

describe('OpenAICompatibleGenerationProvider', () => {
  it('returns the drafted claim', async () => {
    const p = make(answering('El umbral de fraude es 3%.'));
    expect(await p.draftClaim('Acta', 'cuerpo')).toEqual({ claim: 'El umbral de fraude es 3%.' });
  });

  it('a passage stating nothing confirmable produces NO card', async () => {
    // Spending a person's fifteen seconds on a question with no answer is
    // worse than proposing one candidate fewer.
    expect(await make(answering('NONE')).draftClaim('Acta', 'hola')).toBeNull();
    expect(await make(answering('')).draftClaim('Acta', 'hola')).toBeNull();
    expect(await make(answering(null)).draftClaim('Acta', 'hola')).toBeNull();
  });

  it('takes the first line when the model ignores "one sentence"', async () => {
    const p = make(answering('La primera.\nY otra cosa.\nY otra.'));
    expect((await p.draftClaim('t', 'x'))?.claim).toBe('La primera.');
  });

  it('strips the quotes a model likes to add', async () => {
    expect((await make(answering('«El umbral es 3%»')).draftClaim('t', 'x'))?.claim).toBe(
      'El umbral es 3%',
    );
  });

  it('sends the key as a bearer token and caps how much of the note travels', async () => {
    const f = answering('ok');
    await make(f).draftClaim('t', 'x'.repeat(5000));
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string);
    expect(body.messages[1].content.length).toBeLessThanOrEqual(DRAFT_PASSAGE_CHARS + 20);
  });

  it('a provider error is thrown, not swallowed into a fake claim', async () => {
    // The caller decides what a failure means (fewer cards). Inventing one
    // here would put an unsourced sentence in front of an owner.
    await expect(make(answering('x', false)).draftClaim('t', 'x')).rejects.toThrow(/500/);
  });
});
