/**
 * Diluxite — DDW connector: ingest DDW-governed documents as notes.
 *
 * Walks a directory of git clones, reads what DDW (Dilux Development
 * Workflow) leaves committed in each repo — PRDs, specs, decisions, ADRs,
 * threat models, SAST/test/verify reports, multirepo indexes, the family
 * catalog — and upserts them into Diluxite as notes, so hybrid search and
 * the MCP tools can answer over them. Design: docs/ddw-connector-design.md.
 *
 * Mapping (derived, never configured):
 *   - one DDW family = one workspace, named by the `Family` field of each
 *     repo's `AGENTS.md` § `## Repo family`; repos with no family land in
 *     DDW_DEFAULT_WORKSPACE (default "mis-repos").
 *   - tags/wikilinks ride the note TEXT (that is how Diluxite derives them);
 *     each note links its repo hub, each repo hub links its family hub.
 *   - incremental by git blob sha, recorded in an HTML-comment footer; a
 *     source file that disappears gets its note ANNOTATED as archived —
 *     never trashed, never silently dropped.
 *
 * Usage:
 *   pnpm ingest:ddw                       # scan ~/repos into the local DB
 *   DDW_REPOS_DIR=/path pnpm ingest:ddw
 *   DDW_DRY_RUN=1 pnpm ingest:ddw         # plan only, write nothing
 *   DDW_REPOS=a,b,c pnpm ingest:ddw       # explicit repo names
 *   DATABASE_URL=... pnpm ingest:ddw
 *
 * Read-only over the repos; never touches git state. Writes go through
 * NotesService (upsert by title + reindex), so the result is
 * indistinguishable from notes written through the API.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDb } from '../packages/db/src/client';
import { DrizzleNotesRepository } from '../packages/db/src/notes-repository';
import { DrizzleSearchRepository } from '../packages/db/src/search-repository';
import { DrizzleSpacesRepository, ensureSingleUserBootstrap } from '../packages/db/src/spaces-repository';
import {
  archiveAnnotation,
  buildDdwNoteSpec,
  buildFamilyHub,
  buildRepoHub,
  type DdwSourceDoc,
  DeterministicEmbeddingProvider,
  isArchiveAnnotated,
  NotesService,
  parseRepoFamily,
  parseSourceFooter,
  SearchService,
  workspaceNameFor,
} from '../packages/core/src/index';

// ───── env config, house style ─────────────────────────────────────────
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';
const REPOS_DIR = process.env.DDW_REPOS_DIR ?? path.join(os.homedir(), 'repos');
const EXPLICIT_REPOS = (process.env.DDW_REPOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DRY_RUN = process.env.DDW_DRY_RUN === '1';
const DEFAULT_WORKSPACE = process.env.DDW_DEFAULT_WORKSPACE ?? 'mis-repos';

const DDW_DIRS = ['docs/ddw/prd', 'docs/ddw/specs', 'docs/ddw/security', 'docs/ddw/reports', 'docs/adr'];
const DDW_FILES = ['docs/ddw/family-catalog.md'];

function git(repoDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8' }).trim();
}

function blobShaOf(repoDir: string, relPath: string): string {
  return git(repoDir, 'hash-object', relPath);
}

function listDdwFiles(repoDir: string): string[] {
  const out: string[] = [];
  for (const dir of DDW_DIRS) {
    const abs = path.join(repoDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      if (name.endsWith('.md')) out.push(path.posix.join(dir, name));
    }
  }
  for (const f of DDW_FILES) {
    if (fs.existsSync(path.join(repoDir, f))) out.push(f);
  }
  return out.sort();
}

interface RepoScan {
  name: string;
  family: string | null;
  workspaceName: string;
  docs: DdwSourceDoc[];
}

function scanRepo(reposDir: string, name: string): RepoScan | null {
  const repoDir = path.join(reposDir, name);
  if (!fs.existsSync(path.join(repoDir, '.git'))) return null;
  let agents = '';
  try {
    agents = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf-8');
  } catch {
    /* a repo without AGENTS.md can still carry DDW docs */
  }
  const section = parseRepoFamily(agents);
  const docs: DdwSourceDoc[] = [];
  for (const relPath of listDdwFiles(repoDir)) {
    const content = fs.readFileSync(path.join(repoDir, relPath), 'utf-8');
    docs.push({
      repo: name,
      relPath,
      content,
      blobSha: blobShaOf(repoDir, relPath),
      family: section?.family ?? null,
    });
  }
  if (docs.length === 0) return null;
  return {
    name,
    family: section?.family ?? null,
    workspaceName: workspaceNameFor(section, DEFAULT_WORKSPACE),
    docs,
  };
}

async function main() {
  const candidates =
    EXPLICIT_REPOS.length > 0
      ? EXPLICIT_REPOS
      : fs
          .readdirSync(REPOS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();

  const scans = candidates
    .map((name) => scanRepo(REPOS_DIR, name))
    .filter((s): s is RepoScan => s !== null);

  if (scans.length === 0) {
    console.log(`[ddw] no DDW-governed repos found under ${REPOS_DIR} — nothing to ingest.`);
    return;
  }

  const byWorkspace = new Map<string, RepoScan[]>();
  for (const s of scans) {
    const list = byWorkspace.get(s.workspaceName) ?? [];
    list.push(s);
    byWorkspace.set(s.workspaceName, list);
  }

  if (DRY_RUN) {
    for (const [ws, repos] of byWorkspace) {
      console.log(`[ddw] workspace "${ws}":`);
      for (const r of repos) console.log(`  - ${r.name}: ${r.docs.length} doc(s)`);
    }
    console.log('[ddw] dry run — nothing written.');
    return;
  }

  const { sql, db } = createDb(DATABASE_URL);
  try {
    const boot = await ensureSingleUserBootstrap(db);
    const spacesRepo = new DrizzleSpacesRepository(db);
    const notesRepo = new DrizzleNotesRepository(db);
    const searchRepo = new DrizzleSearchRepository(db);
    // Mirror the runtime embedder's dimension, seed-demo's precedence.
    const dimensions =
      Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS) > 0
        ? Number(process.env.OLLAMA_EMBEDDING_DIMENSIONS)
        : Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
    const indexer = new SearchService(searchRepo, new DeterministicEmbeddingProvider(dimensions), notesRepo);
    const notes = new NotesService(notesRepo, indexer);

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let archived = 0;
    // ADR-002: this door knows exactly what it is. `derivedFromRef` carries
    // the repo and path the note was built from, which is prov:wasDerivedFrom
    // and also what tells a reader that editing the note by hand will be
    // overwritten on the next run.
    const connectorBy = (ref?: string) => ({
      attributedTo: null,
      agentKind: 'connector' as const,
      generatedBy: 'import:ddw',
      ...(ref ? { derivedFromRef: ref } : {}),
    });
    let skipped = 0;

    for (const [wsName, repos] of byWorkspace) {
      // find-or-create the workspace by name (no unique index on names — fine
      // for a single on-demand run; see the design doc).
      const existing = (await spacesRepo.listForOrg(boot.orgId)).find(
        (s) => s.name.toLowerCase() === wsName.toLowerCase(),
      );
      const space = existing ?? (await spacesRepo.create(boot.orgId, wsName, boot.userId));
      const spaceId = space.id;

      const families = new Map<string, string[]>();
      for (const repo of repos) {
        const docTitles: string[] = [];
        const livePaths = new Set(repo.docs.map((d) => d.relPath));

        for (const doc of repo.docs) {
          const spec = buildDdwNoteSpec(doc);
          if (!spec) continue;
          docTitles.push(spec.title);
          const before = await notesRepo.findByTitle(spaceId, spec.title);
          if (before) {
            const footer = parseSourceFooter(before.contentMd);
            // Only ever overwrite a note THIS connector wrote for THIS source.
            // The archive pass below already checked the footer before
            // touching anything; this path did not, so a hand-written note
            // that happened to be titled `DDW · <repo> · <path>` had its whole
            // body replaced, silently. Titles are namespaced enough that it is
            // unlikely — but "unlikely and silent and destructive" is the
            // combination worth closing, in a tool whose stated contract is
            // that nothing is ever dropped without saying so.
            if (!footer || footer.repo !== doc.repo || footer.path !== doc.relPath) {
              console.warn(
                `  ⚠️  skipped ${spec.title} — a note with that title exists and was not written by this connector`,
              );
              skipped++;
              continue;
            }
            if (footer.blob === doc.blobSha) {
              unchanged++;
              continue;
            }
            await notes.update(before.id, { contentMd: spec.contentMd }, connectorBy(`${doc.repo}:${doc.relPath}`));
            updated++;
          } else {
            const note = await notes.openOrCreate(spaceId, spec.title);
            await notes.update(note.id, { contentMd: spec.contentMd }, connectorBy(`${doc.repo}:${doc.relPath}`));
            created++;
          }
        }

        // Archive-annotate notes whose source vanished from the repo: found
        // by their footer, never trashed — trash would erase them from
        // search, tags and the graph, which is the opposite of "archived".
        const prefix = `DDW · ${repo.name} · `;
        for (const note of await notesRepo.list(spaceId)) {
          if (!note.title.startsWith(prefix)) continue;
          const footer = parseSourceFooter(note.contentMd);
          if (!footer || footer.repo !== repo.name) continue;
          if (livePaths.has(footer.path) || isArchiveAnnotated(note.contentMd)) continue;
          await notes.update(
            note.id,
            { contentMd: note.contentMd + archiveAnnotation(footer.blob) },
            connectorBy(`${repo.name}:${footer.path}`),
          );
          archived++;
        }

        const hub = buildRepoHub(repo.name, repo.family, docTitles);
        const hubNote = await notes.openOrCreate(spaceId, hub.title);
        await notes.update(hubNote.id, { contentMd: hub.contentMd }, connectorBy());

        if (repo.family) {
          const members = families.get(repo.family) ?? [];
          members.push(repo.name);
          families.set(repo.family, members);
        }
      }

      for (const [family, members] of families) {
        const hub = buildFamilyHub(family, members);
        const hubNote = await notes.openOrCreate(spaceId, hub.title);
        await notes.update(hubNote.id, { contentMd: hub.contentMd }, connectorBy());
      }

      console.log(`[ddw] workspace "${wsName}": ${repos.length} repo(s) ingested.`);
    }

    console.log(
      `[ddw] done — created: ${created} · updated: ${updated} · unchanged: ${unchanged} · ` +
        `archived: ${archived}` +
        (skipped > 0 ? ` · SKIPPED (title taken by a note we did not write): ${skipped}` : '') +
        '.',
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
