import { archiveAnnotation, isArchiveAnnotated, planIngestion } from '@diluxite/core';
import type { AppDeps } from './app';
import { GithubClient, GithubError, type GithubAppCredentials } from './github-client';

/**
 * Ingest a GitHub repository's Markdown as notes — ingestion v1.1.
 *
 * Three rules carried over from the DDW connector, because they were right
 * there and are right here:
 *
 *   1. **Incremental by blob sha.** Git's sha IS the content hash, so a push
 *      costs one tree listing plus the handful of blobs that actually moved.
 *   2. **A file that disappears is ANNOTATED, never trashed.** Deleting the
 *      note would erase the record that it once said something, which is the
 *      opposite of what a memory is for.
 *   3. **Writes go through NotesService**, so the result is indistinguishable
 *      from a note somebody typed — same indexing, same provenance, same
 *      everything downstream.
 */

export interface IngestReport {
  repo: string;
  created: number;
  updated: number;
  unchanged: number;
  annotated: number;
  skipped: string[];
  truncated: boolean;
}

/** The title an ingested file gets. Repo-qualified: two repos have READMEs. */
export function githubNoteTitle(fullName: string, path: string): string {
  return `${fullName}/${path}`;
}

/** The footer that carries where a note came from, and at which blob. */
export function githubFooter(fullName: string, path: string, sha: string, now: Date): string {
  return `<!-- github:source repo=${fullName} path=${path} blob=${sha} ingested=${now.toISOString()} -->`;
}

function bodyFor(fullName: string, path: string, sha: string, content: string, now: Date): string {
  const [owner, repo] = fullName.split('/');
  // Tags ride the TEXT, because that is how Diluxite derives them — and they
  // are the reason an ingested corpus is searchable by repo without a filter
  // nobody knows exists.
  const tags = ['#github', `#repo/${repo ?? fullName}`, `#org/${owner ?? 'unknown'}`];
  return [
    tags.join(' '),
    '',
    content.trim(),
    '',
    '---',
    githubFooter(fullName, path, sha, now),
    '',
  ].join('\n');
}

/**
 * Ingest one repository into a space.
 *
 * `paths` narrows the work to what a push touched; without it the whole tree
 * is planned (still only fetching what changed).
 */
export async function ingestRepo(
  deps: AppDeps,
  opts: {
    orgId: string;
    spaceId: string;
    fullName: string;
    ref: string;
    credentials: GithubAppCredentials;
    installationId: string;
    paths?: string[];
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<IngestReport> {
  if (!deps.github) throw new Error('github repository not wired');
  const now = opts.now ?? (() => new Date());
  const client = new GithubClient(opts.credentials, { fetchImpl: opts.fetchImpl });
  const { token } = await client.installationToken(opts.installationId);

  const tree = await client.tree(token, opts.fullName, opts.ref);
  const known = await deps.github.knownFiles(opts.orgId, opts.fullName);
  const files = opts.paths
    ? tree.files.filter((f) => opts.paths!.includes(f.path))
    : tree.files;
  const plan = planIngestion(files, opts.paths ? new Map() : known);

  const report: IngestReport = {
    repo: opts.fullName,
    created: 0,
    updated: 0,
    unchanged: plan.unchanged.length,
    annotated: 0,
    skipped: plan.tooLarge,
    truncated: tree.truncated,
  };

  for (const file of plan.fetch) {
    const content = await client.blob(token, opts.fullName, file.sha);
    const title = githubNoteTitle(opts.fullName, file.path);
    const { note, created } = await deps.notes.openOrCreateDetailed(opts.spaceId, title, null);
    await deps.notes.update(
      note.id,
      { contentMd: bodyFor(opts.fullName, file.path, file.sha, content, now()) },
      { agentKind: 'connector', generatedBy: 'github', attributedTo: null },
    );
    await deps.github.recordFile({
      orgId: opts.orgId,
      fullName: opts.fullName,
      path: file.path,
      blobSha: file.sha,
      noteId: note.id,
    });
    if (created) report.created++;
    else report.updated++;
  }

  // A source that vanished: annotate the note and forget the file. The note
  // stays — it is the organisation's writing, and a connector does not get to
  // delete somebody's documentation because a path moved.
  for (const path of plan.gone) {
    const noteId = await deps.github.noteFor(opts.orgId, opts.fullName, path);
    const note = noteId ? await deps.notes.get(noteId) : null;
    if (note && !isArchiveAnnotated(note.contentMd)) {
      await deps.notes.update(
        note.id,
        { contentMd: note.contentMd + archiveAnnotation(known.get(path) ?? 'unknown', now()) },
        { agentKind: 'connector', generatedBy: 'github', attributedTo: null },
      );
      report.annotated++;
    }
    await deps.github.forgetFiles(opts.orgId, opts.fullName, [path]);
  }

  return report;
}

/** Ingest everything the installation was granted. */
export async function ingestInstallation(
  deps: AppDeps,
  opts: {
    orgId: string;
    spaceId: string;
    credentials: GithubAppCredentials;
    installationId: string;
    fetchImpl?: typeof fetch;
  },
): Promise<IngestReport[]> {
  const client = new GithubClient(opts.credentials, { fetchImpl: opts.fetchImpl });
  const { token } = await client.installationToken(opts.installationId);
  const repos = await client.installationRepos(token);

  const reports: IngestReport[] = [];
  for (const repo of repos) {
    try {
      reports.push(
        await ingestRepo(deps, {
          ...opts,
          fullName: repo.fullName,
          ref: repo.defaultBranch,
        }),
      );
    } catch (e) {
      // One repository failing — a permission revoked mid-run, a rate limit —
      // must not cost the others. The error is reported per repo rather than
      // aborting a sync that had already done real work.
      const status = e instanceof GithubError ? ` (${e.status})` : '';
      reports.push({
        repo: repo.fullName,
        created: 0,
        updated: 0,
        unchanged: 0,
        annotated: 0,
        skipped: [`error${status}: ${e instanceof Error ? e.message : String(e)}`],
        truncated: false,
      });
    }
  }
  return reports;
}
