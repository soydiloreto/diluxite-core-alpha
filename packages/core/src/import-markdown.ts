/**
 * A folder of Markdown files, read back into notes.
 *
 * The mirror of `export-markdown.ts`, and the way in from the tools people
 * already keep their notes in. What arrives is a list of paths and their
 * contents — unzipped by the caller, because reading an archive is I/O and
 * this is a pure function that can be tested one file at a time.
 *
 * Three shapes, because three exports look different on disk:
 *
 *   - **obsidian** — plain Markdown in folders, `[[wikilinks]]` and inline
 *     `#tags`, which is what Diluxite already speaks. Nothing to translate.
 *   - **notion** — every file and folder carries a 32-hex id in its name
 *     (`Roadmap a1b2…f0.md`), and links between pages are relative URLs to
 *     those files. Both are undone here, or every note would be titled with a
 *     hash and every internal link would 404.
 *   - **markdown** — the generic case, and where Joplin's Markdown export
 *     lands: folders and `.md` files, links left exactly as they are. Guessing
 *     at a format's link syntax without being sure of it produces an import
 *     that looks complete and is quietly broken.
 *
 * What this does NOT do, on purpose: attachments. An image in a vault is a
 * file Diluxite has nowhere to put yet (`Attachments` is its own roadmap
 * row), and importing the note while dropping its image would leave a broken
 * link the person cannot see. They are reported as skipped, with the count,
 * so what did not come across is visible rather than assumed.
 */

export type ImportFormat = 'obsidian' | 'notion' | 'markdown';

export interface ImportFile {
  /** Relative POSIX path inside the archive. */
  path: string;
  content: string;
}

export interface ImportedNote {
  title: string;
  contentMd: string;
  /** Folder names from the root down; empty means the workspace root. */
  folderPath: string[];
  /** Where it came from, so a report can name the file rather than the note. */
  sourcePath: string;
  /** `id` from our own export's frontmatter, when this is a re-import. */
  externalId?: string;
  favorite?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ImportPlan {
  format: ImportFormat;
  notes: ImportedNote[];
  skipped: SkippedFile[];
}

/**
 * Notion suffixes every page file and folder with a 32-hex id.
 *
 * ONE whitespace character, not `\s+`: a quantifier in front of a fixed-width
 * pattern makes the engine retry every split of a run of spaces at every start
 * position — polynomial backtracking on a filename, which arrives inside an
 * archive somebody else built. Notion writes exactly one space, and
 * `stripNotionId` trims afterwards anyway.
 */
const NOTION_ID = /\s[0-9a-f]{32}$/i;

/** Junk that is in every archive and belongs to no note. */
function isIgnorable(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (s) =>
      s === '__MACOSX' ||
      s === '.obsidian' ||
      s === '.trash' ||
      s === '_resources' ||
      s === '.DS_Store' ||
      s.startsWith('._'),
  );
}

/**
 * What this archive is, from what is in it.
 *
 * Detection before parsing, because the two formats that need translating
 * announce themselves: Obsidian keeps its settings in `.obsidian/`, and Notion
 * puts a 32-hex id on every single file it exports.
 */
export function detectImportFormat(files: ImportFile[]): ImportFormat {
  if (files.some((f) => f.path.split('/').includes('.obsidian'))) return 'obsidian';
  const markdown = files.filter((f) => f.path.toLowerCase().endsWith('.md'));
  if (markdown.length === 0) return 'markdown';
  const notionish = markdown.filter((f) =>
    NOTION_ID.test(f.path.replace(/\.md$/i, '').split('/').pop() ?? ''),
  );
  // A majority, not one file: a vault can contain a note whose title happens
  // to end in a hex string, and one such note should not rewrite every title
  // in the import.
  return notionish.length > markdown.length / 2 ? 'notion' : 'markdown';
}

/**
 * The archive's own top folder, when it has exactly one.
 *
 * Every export ships as `MyVault/…` or `Export-a1b2…/…`, and importing that
 * literally buries the whole workspace one level down in a folder named after
 * the ZIP.
 */
function commonRoot(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/');
  if (first.length < 2) return null;
  const root = first[0];
  if (!paths.every((p) => p.startsWith(`${root}/`))) return null;
  // A wrapper holds the whole export, so it has several children. One child
  // means this is a real folder — `Docs/Arquitectura.md` is a note in Docs,
  // not a vault called Docs — and stripping it would lose the folder. When in
  // doubt this keeps a level rather than dropping one: an extra folder is
  // visible and fixable, a lost one is not.
  const children = new Set(paths.map((p) => p.slice(root.length + 1).split('/')[0]));
  return children.size > 1 ? root : null;
}

/**
 * Frontmatter, as much of it as our own export writes.
 *
 * Not a YAML parser and not pretending to be one: `key: value` on its own
 * line, quotes stripped. Anything richer stays in the body, where a person can
 * see it, instead of being half-understood.
 */
export function stripFrontmatter(md: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!md.startsWith('---\n')) return { meta: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: md };
  const block = md.slice(4, end);
  const meta: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    if (key) meta[key] = value;
  }
  const body = md.slice(end + 4).replace(/^\n+/, '');
  return { meta, body };
}

/** `Roadmap a1b2…f0` → `Roadmap`. Leaves a name without an id alone. */
export function stripNotionId(name: string): string {
  return name.replace(NOTION_ID, '').trim();
}

/**
 * Notion's relative page links, as wikilinks.
 *
 * `[Roadmap](Roadmap%20a1b2….md)` becomes `[[Roadmap]]`, which is the link a
 * person can follow here. Left alone: absolute URLs (they still work) and
 * links to anything that is not a `.md` file (an image the import did not
 * bring across — a wikilink to it would be a promise Diluxite cannot keep).
 */
export function notionLinksToWikilinks(md: string): string {
  // Scanned rather than matched. Every regex that describes `[text](target)`
  // has two parts that can claim the same characters — the run before `]` and
  // the `[` in front of it, or the target and the `)` that ends it — so a body
  // of `[](!!!…` retries every split at every position. CodeQL flagged three
  // shapes of this, one after the other, and the fourth would have been the
  // same conversation. Scanning visits each character a bounded number of
  // times and needs no argument about it.
  let out = '';
  let at = 0;
  for (;;) {
    const mid = md.indexOf('](', at);
    if (mid === -1) break;
    const close = md.indexOf(')', mid + 2);
    // The link text starts at the nearest `[` before the `]`, and never
    // crosses a line: `[` from an earlier paragraph is not this link's.
    const open = md.lastIndexOf('[', mid);
    const lineStart = md.lastIndexOf('\n', mid);
    if (close === -1 || open === -1 || open < lineStart) {
      out += md.slice(at, mid + 2);
      at = mid + 2;
      continue;
    }
    const text = md.slice(open + 1, mid);
    const href = md.slice(mid + 2, close);
    const rewritten = asWikilink(text, href);
    if (rewritten === null) {
      out += md.slice(at, close + 1);
    } else {
      out += md.slice(at, open) + rewritten;
    }
    at = close + 1;
  }
  return out + md.slice(at);
}

/** One link, or `null` when it is not a Notion page link to rewrite. */
function asWikilink(text: string, href: string): string | null {
  if (href === '' || /\s/.test(href)) return null;
  if (!/\.md$/i.test(href)) return null; // an image, a CSV, an anchor
  if (/^[a-z]+:/i.test(href)) return null; // http:, mailto:, obsidian:…
  let target: string;
  try {
    target = decodeURIComponent(href);
  } catch {
    // A malformed escape is not worth failing an import over.
    return null;
  }
  const base = stripNotionId((target.split('/').pop() ?? '').replace(/\.md$/i, ''));
  if (!base) return null;
  const label = text.trim();
  return label && label !== base ? `[[${base}|${label}]]` : `[[${base}]]`;
}

/**
 * Titles are unique per workspace (migration 0020), so the importer has to
 * decide what to do about two files that want the same one — before the
 * database does, where the second insert would simply fail.
 *
 * ` (2)`, ` (3)`… same as the export does for colliding filenames. Compared
 * case-insensitively: `Reunión` and `REUNIÓN` are one title as far as the
 * uniqueness index is concerned.
 */
function uniqueTitle(desired: string, taken: Set<string>): string {
  const base = desired.trim() || 'Untitled';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${base} (${n++})`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * The notes an archive would create, and everything it would not.
 *
 * Pure: it reads nothing and writes nothing. The caller unzips, calls this,
 * and then creates what came back — which is also what makes a dry run
 * possible, and why the skipped list is part of the result rather than a log
 * line nobody reads.
 */
export function planImport(files: ImportFile[], format?: ImportFormat): ImportPlan {
  const resolved = format ?? detectImportFormat(files);
  const notes: ImportedNote[] = [];
  const skipped: SkippedFile[] = [];

  const root = commonRoot(files.map((f) => f.path));
  const taken = new Set<string>();

  for (const file of files) {
    const path = root ? file.path.slice(root.length + 1) : file.path;
    if (path === '' || isIgnorable(path)) {
      skipped.push({ path: file.path, reason: 'not part of the notes' });
      continue;
    }
    if (!/\.(md|markdown)$/i.test(path)) {
      skipped.push({
        path: file.path,
        reason: 'attachments are not imported yet — the note that referenced it came across',
      });
      continue;
    }
    if (file.content.trim() === '') {
      skipped.push({ path: file.path, reason: 'empty file' });
      continue;
    }

    const segments = path.split('/');
    const filename = segments.pop()!.replace(/\.(md|markdown)$/i, '');
    const folderPath = segments.map((s) => (resolved === 'notion' ? stripNotionId(s) : s));

    const { meta, body: withoutMeta } = stripFrontmatter(file.content);
    const body = resolved === 'notion' ? notionLinksToWikilinks(withoutMeta) : withoutMeta;

    // The title, in order of what is most likely to be right: our own export's
    // frontmatter, then a Notion H1 (its filename is the title plus a hash,
    // but the heading is the title as typed), then the filename.
    const fromHeading =
      resolved === 'notion'
        ? // `# ` then a non-space, rather than `\s+(.+)`: with both sides able
          // to match a space, a heading of nothing but spaces is retried at
          // every split.
          /^# +(\S.*)$/m.exec(body.split('\n').slice(0, 3).join('\n'))?.[1]
        : null;
    const rawTitle =
      meta.title || fromHeading?.trim() || (resolved === 'notion' ? stripNotionId(filename) : filename);

    notes.push({
      title: uniqueTitle(rawTitle, taken),
      // Notion repeats the title as an H1 in the body; keeping it would show
      // the title twice in a product that renders it above the note.
      // `# ` then a non-space, for the same reason the heading was matched
      // that way above: `\s+.+` lets both sides claim a space.
      contentMd: fromHeading ? body.replace(/^# +\S.*\n+/, '') : body,
      folderPath,
      sourcePath: file.path,
      externalId: meta.id || undefined,
      favorite: meta.favorite === 'true' || undefined,
      createdAt: meta.created || undefined,
      updatedAt: meta.updated || undefined,
    });
  }

  return { format: resolved, notes, skipped };
}
