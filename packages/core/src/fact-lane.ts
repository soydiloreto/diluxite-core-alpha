import type { Fact } from './facts';

/**
 * The structured lane of a search — ADR-001's third channel.
 *
 * It runs on EVERY query, and that is the design rather than an oversight. A
 * classifier deciding whether a question "looks factual" would be one more
 * place to be confidently wrong, and it would fail silently: the classifier
 * says prose, the prose answers plausibly, and the exact row nobody consulted
 * sits unread. Instead the space's own keys decide — if the question names
 * one, there is a fact to bring; if not, this costs an indexed lookup and
 * returns nothing.
 *
 * Nothing here goes through RRF. RRF fuses rankings and discards scores,
 * which is exactly what makes it right for combining BM25 with cosine
 * distance and wrong here: a key either appears in the question or it does
 * not. Averaged into prose, an exact answer lands third behind two paragraphs
 * about the topic — the answer the reader came for, lost.
 */

/** A key the question mentions, and where it appeared. */
export interface KeyMatch {
  key: string;
  /** Length of the matched key, in characters — longer is more specific. */
  length: number;
}

const WORD_BOUNDARY = /[\p{L}\p{N}_]/u;

/**
 * Find which of a space's keys the question actually names.
 *
 * Whole-token matching, not substring: without it the key `MRR` would fire on
 * the word `MRRs` and the key `AI` on `said`, and a wrong exact answer is the
 * one failure this lane must not have.
 *
 * Longer matches win. When a space has both `MRR` and `MRR neto`, a question
 * mentioning the second names the second — a shorter key contained inside a
 * longer match is dropped rather than answered alongside it.
 */
export function matchKeys(query: string, keys: string[]): KeyMatch[] {
  const haystack = query.toLowerCase();
  const found: KeyMatch[] = [];

  for (const key of keys) {
    const needle = key.toLowerCase().trim();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      const before = at > 0 ? haystack[at - 1] : '';
      const after = at + needle.length < haystack.length ? haystack[at + needle.length] : '';
      const boundedLeft = before === '' || !WORD_BOUNDARY.test(before);
      const boundedRight = after === '' || !WORD_BOUNDARY.test(after);
      if (boundedLeft && boundedRight) {
        found.push({ key, length: needle.length });
        break;
      }
      from = at + 1;
    }
  }

  // Longest first, then drop any key wholly contained in a longer match.
  found.sort((a, b) => b.length - a.length);
  const kept: KeyMatch[] = [];
  for (const candidate of found) {
    const shadowed = kept.some((k) =>
      k.key.toLowerCase().includes(candidate.key.toLowerCase()),
    );
    if (!shadowed) kept.push(candidate);
  }
  return kept;
}

/**
 * Rank the facts of a matched key against the question.
 *
 * Only the COLUMN is scored, because the key is already an exact match: the
 * question "what is the MRR" and "who owns MRR" differ in which column they
 * want. A question that names no column gets every column of that key, in
 * table order — better to hand over the whole row than to guess which cell
 * was meant.
 */
export function rankFactsForQuery<T extends { columnName: string }>(
  query: string,
  hits: T[],
): T[] {
  const q = query.toLowerCase();
  const named = hits.filter((h) => {
    const col = h.columnName.toLowerCase().trim();
    return col.length > 0 && q.includes(col);
  });
  return named.length > 0 ? named : hits;
}

/** Shape a fact into the one sentence an answer can quote. */
export function factSentence(f: {
  key: string;
  keyColumn: string;
  columnName: string;
  value: string;
}): string {
  return `${f.key} · ${f.columnName}: ${f.value}`;
}

/** Everything the lane found for one query, ready to compose above the prose. */
export interface FactAnswer<T> {
  key: string;
  hits: T[];
}

export type { Fact };
