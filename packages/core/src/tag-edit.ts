import { maskCodeSpans } from './code-spans';
import { parseTags } from './tags';

/**
 * Adding and removing a `#tag` in a note's markdown.
 *
 * WHY THE MARKDOWN AND NOT THE `note_tags` TABLE. Tags are DERIVED: every save
 * re-reads them from the body (`SearchService.index` → `parseTags` → `setTags`,
 * replacing the row set). A bulk tag that wrote rows would look like it worked
 * and then vanish the next time somebody typed a character in the note. The
 * text is the source of truth, so a tag is added by editing the text.
 *
 * Both functions are pure and idempotent, which is what a bulk operation over
 * a hundred notes needs: applying it twice is applying it once, and a note that
 * already carries the tag is left byte-for-byte alone rather than re-saved.
 */

/** `#tag`, per the grammar `parseTags` reads: a letter, then letters/digits/_/-//. */
const TAG_BODY = /^\p{L}[\p{L}\p{N}_/-]*$/u;

/** Strips a leading `#` and says whether what remains is a tag at all. */
export function normaliseTag(input: string): string | null {
  const bare = input.trim().replace(/^#/, '');
  return TAG_BODY.test(bare) ? bare : null;
}

function hasTag(md: string, tag: string): boolean {
  const wanted = tag.toLowerCase();
  return parseTags(md).some((t) => t.toLowerCase() === wanted);
}

/**
 * Is this line nothing but tags?
 *
 * Used to decide where a new tag goes: onto the note's existing tag line, if
 * it has one, rather than starting a second one underneath it.
 */
function isTagLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return trimmed.split(/\s+/).every((word) => /^#/.test(word) && normaliseTag(word) !== null);
}

/**
 * The markdown with `#tag` present, or the markdown unchanged.
 *
 * Placement, in order of preference: the note's existing tag line, or a new
 * line at the end separated by a blank one. A tag appended to the last
 * sentence would read as part of it.
 */
export function addTagToMarkdown(md: string, tag: string): string {
  const clean = normaliseTag(tag);
  if (!clean) throw new Error(`not a tag: ${tag}`);
  if (hasTag(md, clean)) return md;

  const lines = md.split('\n');
  // Trailing blank lines are not content; find the last line that is.
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === '') last--;
  if (last < 0) return `#${clean}`; // an empty note

  // Whether the note ended in a newline is worth preserving — it is the
  // difference between a diff of one line and a diff of two.
  const trailingNewline = md.endsWith('\n') ? '\n' : '';

  if (isTagLine(lines[last])) {
    lines[last] = `${lines[last].trimEnd()} #${clean}`;
    return lines.slice(0, last + 1).join('\n') + trailingNewline;
  }
  return `${lines.slice(0, last + 1).join('\n')}\n\n#${clean}${trailingNewline}`;
}

/**
 * The markdown without `#tag`, wherever it appears — except inside code.
 *
 * `#include` in a fenced block is not a tag, `parseTags` never saw it, and
 * removing it would corrupt the code. Detection runs on the masked copy, which
 * keeps every offset, and the edits are applied to the original by index.
 */
export function removeTagFromMarkdown(md: string, tag: string): string {
  const clean = normaliseTag(tag);
  if (!clean) throw new Error(`not a tag: ${tag}`);
  if (!hasTag(md, clean)) return md;

  const masked = maskCodeSpans(md);
  // The same shape `parseTags` matches, pinned to this tag and to a boundary,
  // so `#work` does not eat the `#work` inside `#workflow`.
  const re = new RegExp(
    `(^|\\s|(?<!\\])\\()#${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_/-])`,
    'giu',
  );
  let out = '';
  let at = 0;
  for (const m of masked.matchAll(re)) {
    const start = m.index!;
    const before = m[1] ?? '';
    out += md.slice(at, start);
    at = start + m[0].length;
    // ONE adjacent space goes with the tag, or removing `#infra` from "una
    // nota con #infra adentro" leaves two spaces in the middle of a sentence.
    // A plain space in front is the one to drop. A newline in front is not a
    // separator, it is the previous line ending — keep it, and take the space
    // BEHIND the tag instead, which is the one a tag line leaves.
    if (before !== ' ' && before !== '\t') {
      out += before;
      if (md[at] === ' ' || md[at] === '\t') at += 1;
    }
  }
  out += md.slice(at);

  // A line that held only that tag is gone; what it leaves behind is a run of
  // blank lines the note did not ask for — and, at the end, a trailing blank
  // line where the tag line used to be.
  return out.replace(/\n{3,}/g, '\n\n').replace(/\n{2,}$/, '\n');
}
