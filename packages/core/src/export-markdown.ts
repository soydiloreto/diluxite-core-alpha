/**
 * A workspace as a folder of Markdown files — the thing you can walk away
 * with.
 *
 * A second brain that cannot be exported into files anyone else can read is a
 * silo with better manners. What comes out here is what went in: the note's
 * own Markdown, wikilinks and inline `#tags` untouched, in the folder tree it
 * was written in. Obsidian, VS Code, `grep` and the next tool all read it
 * without an importer.
 *
 * Metadata that is NOT in the body goes to YAML frontmatter, and only that:
 * tags are already inline, so writing them again would create a second copy
 * to disagree with the first.
 */

export interface ExportableNote {
  id: string;
  title: string;
  contentMd: string;
  folderId: string | null;
  favorite?: boolean;
  /** `Date` from the repository, string from a plain payload — both accepted. */
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export interface ExportableFolder {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ExportedFile {
  /** Relative POSIX path inside the archive. Never absolute, never escaping. */
  path: string;
  content: string;
  /**
   * The note's own `updatedAt`, so unzipping into a vault gives files whose
   * dates mean something — clamped into the range a ZIP can represent.
   */
  modified: Date;
}

/**
 * ZIP stores a DOS timestamp and cannot represent anything outside
 * 1980–2099. A note dated outside it is not a reason to fail an export, so
 * the value is clamped rather than rejected.
 */
const ZIP_EPOCH = new Date('1980-01-01T00:00:00Z');
const ZIP_LAST = new Date('2099-12-31T23:59:58Z');
export function zipSafeDate(value: string | Date | undefined, fallback = ZIP_EPOCH): Date {
  const d = value === undefined ? fallback : value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  if (d < ZIP_EPOCH) return ZIP_EPOCH;
  if (d > ZIP_LAST) return ZIP_LAST;
  return d;
}

/** Longest a single path segment may be, in characters. */
const MAX_SEGMENT = 120;

/**
 * Windows refuses these as file names whatever the extension, and a ZIP
 * unpacked there would fail on exactly one file with an error naming neither
 * the note nor the reason.
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * A title turned into one safe path SEGMENT.
 *
 * Segment, not path: every separator is replaced rather than kept, so a note
 * called `../../etc/passwd` becomes a file in the archive rather than a write
 * outside it. Everything an unzip on Windows, macOS or Linux would reject
 * goes too — a portable export that unpacks on one of the three is not one.
 */
export function safeSegment(raw: string, fallback = 'untitled'): string {
  let s = raw.normalize('NFC');
  // Separators and the characters Windows forbids, plus control codes.
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f || '/\\:*?"<>|'.includes(ch) ? '-' : ch;
  }
  // Trailing dots and spaces are silently dropped by Windows, which turns two
  // distinct titles into one file and loses a note without saying so.
  s = out.trim().replace(/[. ]+$/u, '').trim();
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT).trim().replace(/[. ]+$/u, '');
  if (RESERVED.has(s.toLowerCase())) s = `${s}-`;
  return s.length > 0 ? s : fallback;
}

/** ISO 8601, whichever of the two shapes the caller had. */
function isoString(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/** YAML-quote a scalar. Only ever called with strings we then control. */
function yamlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Frontmatter for what the body cannot carry.
 *
 * `id` is here so a re-import can recognise the same note rather than
 * duplicating it, and so a link between exports stays resolvable.
 */
export function frontmatter(note: ExportableNote): string {
  const lines = [`id: ${yamlString(note.id)}`, `title: ${yamlString(note.title)}`];
  if (note.createdAt) lines.push(`created: ${yamlString(isoString(note.createdAt))}`);
  if (note.updatedAt) lines.push(`updated: ${yamlString(isoString(note.updatedAt))}`);
  if (note.favorite) lines.push('favorite: true');
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * Every note as a file, under the folder tree it lives in.
 *
 * Two notes whose FILENAMES collide get ` (2)`, ` (3)`… rather than one
 * overwriting the other. Titles are unique per space (migration 0020), so it
 * is sanitisation that creates the collisions: `Nota/uno` and `Nota-uno`
 * become one name, as do `Nota.` and `Nota`, and `Reunión` and `REUNIÓN` are
 * two live notes that land on one file on macOS and Windows. Hence the
 * case-insensitive comparison — an export that assumes the titles stay
 * distinct through sanitisation loses notes silently.
 *
 * A note whose folder is missing (deleted mid-export, or a stale id) lands at
 * the root instead of being dropped.
 */
export function exportWorkspace(
  notes: ExportableNote[],
  folders: ExportableFolder[],
): ExportedFile[] {
  const byId = new Map(folders.map((f) => [f.id, f]));

  const dirCache = new Map<string | null, string>([[null, '']]);
  const dirFor = (folderId: string | null): string => {
    const cached = dirCache.get(folderId);
    if (cached !== undefined) return cached;
    const segments: string[] = [];
    const seen = new Set<string>();
    let cursor = folderId;
    // `seen` guards a parent cycle: bad data must not hang an export.
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = byId.get(cursor);
      if (!folder) break;
      segments.unshift(safeSegment(folder.name, 'folder'));
      cursor = folder.parentId;
    }
    const dir = segments.join('/');
    dirCache.set(folderId, dir);
    return dir;
  };

  const taken = new Set<string>();
  const files: ExportedFile[] = [];
  for (const note of notes) {
    const dir = dirFor(note.folderId);
    const base = safeSegment(note.title);
    let path = `${dir ? `${dir}/` : ''}${base}.md`;
    for (let n = 2; taken.has(path.toLowerCase()); n += 1) {
      path = `${dir ? `${dir}/` : ''}${base} (${n}).md`;
    }
    taken.add(path.toLowerCase());
    files.push({
      path,
      content: frontmatter(note) + note.contentMd,
      modified: zipSafeDate(note.updatedAt ?? note.createdAt),
    });
  }
  return files;
}
