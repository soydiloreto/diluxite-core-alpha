/**
 * The drafting provider — ADR-006.
 *
 * The one place a generative model is allowed near this product, and its whole
 * job is to turn a passage into a one-line claim an owner can answer with yes
 * or no. It never decides truth, never touches ranking, validity or freshness,
 * never writes to a note, and never answers a user's question.
 *
 * The containment is structural: this port returns a CLAIM, not an answer.
 * There is no method here that takes a user's question, and adding one would
 * be a different product.
 */

/** A claim to put on a card, and where it came from. */
export interface DraftedClaim {
  /** One sentence, answerable with yes or no. */
  claim: string;
}

export interface GenerationProvider {
  /**
   * Draft the claim a passage is making.
   *
   * Returning null is a normal outcome — a passage that states nothing
   * confirmable should produce no card rather than an invented one. Spending a
   * person's fifteen seconds on a question with no answer is worse than
   * proposing one candidate fewer.
   */
  draftClaim(title: string, passage: string): Promise<DraftedClaim | null>;
}

/**
 * What the model is asked, in full.
 *
 * Kept here, in one exported constant, so the instruction is reviewable and
 * testable rather than buried in an HTTP call — and so a change to it is a
 * change somebody can see in a diff.
 */
export const DRAFT_CLAIM_PROMPT = [
  'You are helping a person review an organisation‘s knowledge base.',
  'From the passage below, write the single most important factual claim it makes,',
  'as ONE sentence that can be confirmed or denied with yes or no.',
  '',
  'Rules:',
  '- Use the passage‘s own words and numbers. Do not add, infer or soften anything.',
  '- No preamble, no quotes, no trailing question mark. Just the sentence.',
  '- If the passage makes no confirmable factual claim, answer exactly: NONE',
].join('\n');

/** How much of a note is sent. A claim lives near the top or not at all. */
export const DRAFT_PASSAGE_CHARS = 1200;

/**
 * A provider over any OpenAI-compatible chat completions endpoint.
 *
 * Deliberately the smallest possible client — one POST, no SDK — for the same
 * reason the Bedrock embedding provider is: a dependency that ships an auth
 * stack for one call is a supply chain for one call.
 */
export class OpenAICompatibleGenerationProvider implements GenerationProvider {
  constructor(
    private readonly opts: {
      endpoint: string;
      model: string;
      apiKey?: string | null;
      /** Injected in tests. */
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async draftClaim(title: string, passage: string): Promise<DraftedClaim | null> {
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await f(this.opts.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          // Low, not zero: some endpoints reject 0. The task is extraction, so
          // any creativity here is a defect.
          temperature: 0.1,
          messages: [
            { role: 'system', content: DRAFT_CLAIM_PROMPT },
            { role: 'user', content: `# ${title}\n\n${passage.slice(0, DRAFT_PASSAGE_CHARS)}` },
          ],
        }),
      });
      if (!res.ok) throw new Error(`generation provider answered ${res.status}`);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) return null;
      // A model that was told to say NONE and said NONE is working correctly.
      if (/^none\b/i.test(text)) return null;
      // One sentence: a model that ignored the instruction and wrote three
      // gets its first taken rather than a paragraph landing on the card.
      const claim = text.split('\n')[0].trim().replace(/^["'«]|["'»]$/g, '');
      return claim ? { claim } : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
