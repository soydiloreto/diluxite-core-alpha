export interface SearchDoc {
  id: string;
  title: string;
  contentMd: string;
}

export interface SearchOpts {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface Match {
  lineNo: number;
  line: string;
}

export interface ResultGroup {
  noteId: string;
  title: string;
  matches: Match[];
}

export interface ScanResult {
  results: ResultGroup[];
  totalMatches: number;
}

export const EMPTY_SCAN: ScanResult = { results: [], totalMatches: 0 };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileQuery(
  query: string,
  opts: SearchOpts,
): { re: RegExp } | { error: string } | null {
  if (!query) return null;
  try {
    const raw = opts.regex ? query : escapeRegExp(query);
    const pattern = opts.wholeWord ? `\\b${raw}\\b` : raw;
    return { re: new RegExp(pattern, opts.matchCase ? 'g' : 'gi') };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Invalid pattern' };
  }
}

export interface PreparedDoc {
  id: string;
  title: string;
  lines: string[];
}

export function prepareDocs(docs: readonly SearchDoc[]): PreparedDoc[] {
  return docs.map((d) => ({ id: d.id, title: d.title, lines: d.contentMd.split('\n') }));
}

export function scanPrepared(docs: readonly PreparedDoc[], re: RegExp): ScanResult {
  const results: ResultGroup[] = [];
  let totalMatches = 0;
  for (const doc of docs) {
    const matches: Match[] = [];
    for (let i = 0; i < doc.lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(doc.lines[i])) matches.push({ lineNo: i + 1, line: doc.lines[i] });
    }
    if (matches.length > 0) {
      results.push({ noteId: doc.id, title: doc.title, matches });
      totalMatches += matches.length;
    }
  }
  return { results, totalMatches };
}

export function scanDocs(docs: readonly SearchDoc[], re: RegExp): ScanResult {
  return scanPrepared(prepareDocs(docs), re);
}

/**
 * Cut the result set down to what will actually be put in the DOM.
 *
 * A one-letter query matches five figures' worth of lines, and rendering
 * them costs seconds of blocked main thread — the scan itself takes two
 * milliseconds. The count in the header stays the real one; this only
 * governs how many rows exist.
 */
export function takeMatches(results: readonly ResultGroup[], limit: number): {
  groups: ResultGroup[];
  shown: number;
} {
  const groups: ResultGroup[] = [];
  let shown = 0;
  for (const g of results) {
    const room = limit - shown;
    if (room <= 0) break;
    if (g.matches.length <= room) {
      groups.push(g);
      shown += g.matches.length;
    } else {
      groups.push({ ...g, matches: g.matches.slice(0, room) });
      shown = limit;
    }
  }
  return { groups, shown };
}

export interface ClippedLine {
  text: string;
  clippedStart: boolean;
  clippedEnd: boolean;
}

/**
 * A single line can be thousands of characters, and a loose query marks
 * dozens of spots in each — so a long line is its own render bomb. Show a
 * window around the first match instead.
 */
export function clipLine(line: string, re: RegExp, maxLength = 240): ClippedLine {
  if (line.length <= maxLength) {
    return { text: line, clippedStart: false, clippedEnd: false };
  }
  re.lastIndex = 0;
  const m = re.exec(line);
  const lead = 32;
  const start = Math.max(0, Math.min((m?.index ?? 0) - lead, line.length - maxLength));
  const end = Math.min(line.length, start + maxLength);
  return { text: line.slice(start, end), clippedStart: start > 0, clippedEnd: end < line.length };
}
