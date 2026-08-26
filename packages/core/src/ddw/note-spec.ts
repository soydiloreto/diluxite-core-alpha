/**
 * DDW document → Diluxite note spec.
 *
 * Diluxite derives tags and wikilinks from the note TEXT at index time — they
 * cannot be set through any API — so this module's whole job is rendering a
 * body whose text carries them: a tag line up top, hub wikilinks, the original
 * document, and an HTML-comment source footer that makes re-ingestion
 * incremental (the blob sha is the "has it changed" answer) without adding
 * visible noise. The title is the note's only identity in Diluxite (unique
 * per space among live notes), so it is deterministic by construction.
 */
import { classifyDdwPath, type DdwDocKind, ticketIdOf } from './sources.js';

export interface DdwSourceDoc {
  /** repo name, e.g. `ddw-demo-back` */
  repo: string;
  /** repo-relative path, e.g. `docs/adr/adr-001-cookies.md` */
  relPath: string;
  content: string;
  /** git blob sha of the file as ingested */
  blobSha: string;
  /** family name, or null for a standalone repo */
  family: string | null;
}

export interface DdwNoteSpec {
  title: string;
  contentMd: string;
  kind: DdwDocKind;
}

const FOOTER = /<!-- ddw:source repo=(\S+) path=(\S+) blob=(\S+) ingested=(\S+) -->/;

/** Deterministic note title — the upsert key. */
export function ddwNoteTitle(repo: string, relPath: string): string {
  return `DDW · ${repo} · ${relPath.replace(/\\/g, '/')}`;
}

/** The per-repo hub note's title (each doc wikilinks to it). */
export function repoHubTitle(repo: string): string {
  return `DDW · ${repo}`;
}

/** The per-family hub note's title (each repo hub wikilinks to it). */
export function familyHubTitle(family: string): string {
  return `DDW · familia ${family}`;
}

/**
 * Render the note body for one DDW document. Tag syntax rules that matter
 * (packages/core/src/tags.ts): tags must start with a letter, may carry
 * `/-_` and digits, and are ignored inside code spans — DDW docs are full of
 * fenced blocks, so the tag line lives outside any fence, at the top.
 */
export function buildDdwNoteSpec(doc: DdwSourceDoc, now = new Date()): DdwNoteSpec | null {
  const kind = classifyDdwPath(doc.relPath, doc.content);
  if (!kind) return null;
  const ticket = ticketIdOf(doc.relPath);
  const tags = ['#ddw', `#repo/${doc.repo}`, `#tipo/${kind}`];
  if (doc.family) tags.push(`#familia/${doc.family}`);
  if (ticket) tags.push(`#ticket/${ticket}`);

  const links = [`[[${repoHubTitle(doc.repo)}]]`];
  const footer =
    `<!-- ddw:source repo=${doc.repo} path=${doc.relPath.replace(/\\/g, '/')} ` +
    `blob=${doc.blobSha} ingested=${now.toISOString()} -->`;

  const body = [tags.join(' '), links.join(' '), '', doc.content.trim(), '', '---', footer, ''].join('\n');
  return { title: ddwNoteTitle(doc.repo, doc.relPath), contentMd: body, kind };
}

/** Read the source footer back from an ingested note, or null. */
export function parseSourceFooter(
  contentMd: string,
): { repo: string; path: string; blob: string; ingested: string } | null {
  const m = FOOTER.exec(contentMd);
  if (!m) return null;
  return { repo: m[1], path: m[2], blob: m[3], ingested: m[4] };
}

/** The repo hub note: family link plus a listing of what was ingested. */
export function buildRepoHub(
  repo: string,
  family: string | null,
  docTitles: string[],
): { title: string; contentMd: string } {
  const tags = ['#ddw', `#repo/${repo}`, '#tipo/hub'];
  if (family) tags.push(`#familia/${family}`);
  const familyLine = family ? `Familia: [[${familyHubTitle(family)}]]` : 'Repo sin familia declarada.';
  const list = docTitles
    .slice()
    .sort()
    .map((t) => `- [[${t}]]`)
    .join('\n');
  return {
    title: repoHubTitle(repo),
    contentMd: [tags.join(' '), '', `# ${repo}`, '', familyLine, '', '## Documentos DDW', '', list, ''].join('\n'),
  };
}

/** The family hub note: one line per member repo hub. */
export function buildFamilyHub(family: string, repoNames: string[]): { title: string; contentMd: string } {
  const tags = ['#ddw', `#familia/${family}`, '#tipo/hub'];
  const list = repoNames
    .slice()
    .sort()
    .map((r) => `- [[${repoHubTitle(r)}]]`)
    .join('\n');
  return {
    title: familyHubTitle(family),
    contentMd: [tags.join(' '), '', `# Familia ${family}`, '', '## Repos', '', list, ''].join('\n'),
  };
}

/** The annotation appended when a source file disappears from its repo. */
export function archiveAnnotation(lastBlob: string, now = new Date()): string {
  return (
    `\n> ⚠️ Source removed from its repository on ${now.toISOString().slice(0, 10)} ` +
    `(last seen blob ${lastBlob}). Kept here as history. #estado/archivado\n`
  );
}

/** Has this note already been annotated as archived? */
export function isArchiveAnnotated(contentMd: string): boolean {
  return contentMd.includes('#estado/archivado');
}
