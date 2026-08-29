import type { RerankDoc, Reranker, Scored } from './providers';

/**
 * A reranker that actually reorders — replacing the no-op default.
 *
 * The pipeline fuses a keyword ranking with a vector ranking through RRF and
 * then handed the result to `IdentityReranker`, which returns it untouched.
 * So the last stage of search did nothing, and the gap it left is specific:
 * **RRF sees only ranks.** It deliberately discards scores, which is what
 * makes it right for combining BM25 with cosine distance — and it means the
 * fused order cannot know whether a document contains the query as a phrase,
 * whether it covers every term, or whether the match is in the title. Those
 * are exactly the signals a second pass should weigh.
 *
 * WHY NOT A MODEL. A cross-encoder is genuinely better at this and the
 * `Reranker` port stays open for one. But it needs a model to run, and a
 * deployment with no keys and no GPU is the default here — an engine that
 * silently does nothing without a model is worse than one that does arithmetic
 * it can explain. Every feature below is countable and every weight is
 * written down, so a bad ranking can be traced to a number instead of shrugged
 * at.
 */

/**
 * Per-feature weights. Tuned by hand, stated openly, and deliberately modest:
 * the fused rank from RRF is the prior, and these adjust it rather than
 * replace it. A reranker that overpowers its input is not reranking, it is
 * searching again with worse tools.
 */
export const RERANK_WEIGHTS = {
  /** The whole query appears verbatim. The strongest signal a human would use. */
  phrase: 3,
  /**
   * Fraction of query terms present. Weighted above the prior: going from one
   * term in three to three in three is a bigger difference than one position
   * in a fused list, and a coverage signal the prior can always outvote is
   * decoration.
   */
  coverage: 3,
  /** A term matched the title rather than the body. */
  title: 1.5,
  /** The match sits near the start of the text. */
  earliness: 0.5,
  /**
   * The fused order from RRF, as a prior. Real but not decisive: RRF combined
   * two channels and deserves respect, yet a document that actually contains
   * the query has to be able to overtake one that merely placed well.
   */
  prior: 2,
} as const;

/** Docs may carry a title; the fused pipeline supplies one when it has it. */
export interface TitledRerankDoc extends RerankDoc {
  title?: string;
}

/** The breakdown behind a score, so a ranking can be explained rather than trusted. */
export interface RerankFeatures {
  phrase: number;
  coverage: number;
  title: number;
  earliness: number;
  priorRank: number;
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The distinct whole words in a string, lower-cased. */
function tokenSet(text: string): Set<string> {
  return new Set(text.match(WORD) ?? []);
}

/** Query terms, lower-cased and de-duplicated. Single characters are noise. */
export function queryTerms(query: string): string[] {
  const raw = query.toLowerCase().match(WORD) ?? [];
  return [...new Set(raw.filter((t) => t.length > 1))];
}

/**
 * Score one document's features against a query.
 *
 * Exported and pure so each signal can be tested on its own — a weighted sum
 * whose parts are untestable is a magic number with extra steps.
 */
export function rerankFeatures(
  query: string,
  doc: TitledRerankDoc,
  priorRank: number,
  totalDocs: number,
): RerankFeatures {
  const terms = queryTerms(query);
  const body = doc.text.toLowerCase();
  const title = (doc.title ?? '').toLowerCase();
  const needle = query.toLowerCase().trim();

  // A phrase is genuinely a substring question, so `includes` is right here.
  const phrase = needle.length > 1 && `${title}\n${body}`.includes(needle) ? 1 : 0;

  // Coverage matches WHOLE TOKENS, never substrings. With `includes`, the
  // query term "de" matched inside "vende" and every Spanish document scored
  // as covering it — the same substring trap the fact lane had to close, and
  // it inflates the one feature meant to say whether the words are there.
  const bodyTokens = tokenSet(body);
  const titleTokens = tokenSet(title);
  const present = terms.filter((t) => bodyTokens.has(t) || titleTokens.has(t)).length;
  const coverage = terms.length === 0 ? 0 : present / terms.length;

  const inTitle = terms.filter((t) => titleTokens.has(t)).length;
  const titleScore = terms.length === 0 ? 0 : inTitle / terms.length;

  // Where the first term lands, as a fraction of the way through the body.
  // A match in the opening sentence is usually what the document is about; one
  // in the last paragraph is often an aside.
  let earliest = -1;
  for (const t of terms) {
    const at = body.indexOf(t);
    if (at >= 0 && (earliest < 0 || at < earliest)) earliest = at;
  }
  const earliness = earliest < 0 || body.length === 0 ? 0 : 1 - earliest / body.length;

  // The fused order as a 0..1 prior, so the reranker adjusts rather than
  // discards what RRF worked out.
  const prior = totalDocs <= 1 ? 1 : (totalDocs - priorRank) / totalDocs;

  return { phrase, coverage, title: titleScore, earliness, priorRank: prior };
}

/** Collapse the features into the number the ordering uses. */
export function rerankScore(f: RerankFeatures): number {
  return (
    f.phrase * RERANK_WEIGHTS.phrase +
    f.coverage * RERANK_WEIGHTS.coverage +
    f.title * RERANK_WEIGHTS.title +
    f.earliness * RERANK_WEIGHTS.earliness +
    f.priorRank * RERANK_WEIGHTS.prior
  );
}

export class LexicalReranker implements Reranker {
  async rerank(query: string, docs: TitledRerankDoc[], topK?: number): Promise<Scored[]> {
    const scored = docs.map((d, i) => ({
      id: d.id,
      score: rerankScore(rerankFeatures(query, d, i, docs.length)),
      priorRank: i,
    }));
    // Ties fall back to the fused order rather than to whatever sort() does,
    // so the output is deterministic — a search that reorders identically
    // scored results between runs is one nobody can debug.
    scored.sort((a, b) => b.score - a.score || a.priorRank - b.priorRank);
    const out = scored.map(({ id, score }) => ({ id, score }));
    return topK ? out.slice(0, topK) : out;
  }
}
