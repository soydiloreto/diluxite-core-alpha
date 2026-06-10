/**
 * Masks Markdown code so syntactic parsers (tags, wikilinks, headings) don't
 * mistake code for real markup — e.g. `#include` inside a ```c fence is not a
 * tag, and a `# foo` line inside a fence is not a heading.
 *
 * "Masking" replaces every character inside a code span with a space while
 * leaving newlines (and therefore line count, line lengths and offsets) intact,
 * so callers that work line-by-line — like the chunker — can test the masked
 * text but still emit the original content.
 *
 * Handles:
 *   - Fenced blocks delimited by ``` or ~~~ (3+ markers), incl. an info string.
 *   - Inline code spans delimited by matching runs of backticks (`…`, ``…``).
 *
 * Anything not closed before EOF (an open fence / dangling backticks) is masked
 * to end-of-input — that mirrors how Markdown renderers treat an unterminated
 * code block, and it's the safe default (don't parse markup we can't trust).
 */
export function maskCodeSpans(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | null = null; // active fence marker char-run, or null

  const blankLine = (line: string) => ' '.repeat(line.length);

  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence === null) {
      if (fenceMatch) {
        // Opening fence: mask the whole fence line, remember the marker.
        fence = fenceMatch[2];
        out.push(blankLine(line));
      } else {
        out.push(maskInlineCode(line));
      }
    } else {
      // Inside a fence: mask everything; a matching marker closes it.
      out.push(blankLine(line));
      if (fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length) {
        fence = null;
      }
    }
  }

  return out.join('\n');
}

/** Masks inline code runs (`` `…` ``, ``` ``…`` ```) within a single line. */
function maskInlineCode(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      // Length of the opening backtick run.
      let run = 0;
      while (line[i + run] === '`') run++;
      const open = i;
      let j = i + run;
      // Find a closing run of exactly the same length.
      let closed = false;
      while (j < line.length) {
        if (line[j] === '`') {
          let r = 0;
          while (line[j + r] === '`') r++;
          if (r === run) {
            // Mask from the opening backtick through the closing run.
            out += ' '.repeat(j + r - open);
            i = j + r;
            closed = true;
            break;
          }
          j += r;
        } else {
          j++;
        }
      }
      if (!closed) {
        // Dangling backticks: not a code span, keep the run literal.
        out += line.slice(open, open + run);
        i = open + run;
      }
    } else {
      out += line[i];
      i++;
    }
  }
  return out;
}
