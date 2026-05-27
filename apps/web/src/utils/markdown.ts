/**
 * Tiny markdown helpers shared across the web app. These mirror the
 * server-side parsers in `@diluxite/core` (tags + wikilinks) so the
 * frontend can extract them without a round-trip — useful for chip bars,
 * tag clouds, the in-memory fake API and tests.
 *
 * Keep the regexes in sync with `packages/core/src/tags.ts` and
 * `packages/core/src/wikilinks.ts` if you change them upstream.
 */

const TAG_RE = /(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Tags found in the markdown, lowercased and de-duplicated, in first-seen order. */
export function extractTags(md: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of md.matchAll(TAG_RE)) {
    const tag = m[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Wikilink targets (`[[Title]]`) lowercased and de-duplicated, first-seen order. */
export function extractWikilinkTargets(md: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of md.matchAll(WIKILINK_RE)) {
    const target = m[1].trim().toLowerCase();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}
