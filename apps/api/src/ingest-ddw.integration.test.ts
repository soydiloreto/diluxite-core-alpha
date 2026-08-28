import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '@diluxite/db';

/**
 * The DDW connector end to end: a fixture git repo carrying DDW artifacts and
 * a `## Repo family` section is ingested into the workspace its family names,
 * with tags/links derived, re-runs idempotent by blob sha, and a source file
 * that disappears getting its note ANNOTATED — never trashed, never silently
 * dropped (docs/ddw-connector-design.md).
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function sh(cwd: string, cmd: string) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function makeFixtureRepo(base: string, name: string): string {
  const dir = join(base, name);
  fs.mkdirSync(join(dir, 'docs/ddw/prd'), { recursive: true });
  fs.mkdirSync(join(dir, 'docs/adr'), { recursive: true });
  sh(dir, 'git init -q .');
  fs.writeFileSync(
    join(dir, 'AGENTS.md'),
    [
      '# fixture',
      '',
      '## Repo family',
      '',
      '| Field | Value |',
      '|---|---|',
      '| Family | familia-test |',
      '| Workspace | acme/ws-test |',
      '| Provides | api |',
      '| Consumed by | none |',
      '| Consumes | none |',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(join(dir, 'docs/ddw/prd/prd-T-1.md'), '# PRD T-1\n\nEl requisito.\n');
  fs.writeFileSync(join(dir, 'docs/adr/adr-001-x.md'), '# ADR 1\n\nLa decision.\n');
  return dir;
}

function runIngest(reposDir: string, repoName: string) {
  execSync('pnpm exec tsx scripts/ingest-ddw.ts', {
    cwd: REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      DATABASE_URL: TEST_URL,
      DDW_REPOS_DIR: reposDir,
      DDW_REPOS: repoName,
    },
  });
}

describe('ingest-ddw — the connector against a real fixture repo', () => {
  let sql: Sql;
  let reposDir: string;

  beforeEach(async () => {
    sql = createDb(TEST_URL).sql;
    await sql`TRUNCATE chunks, notes, memberships, spaces, users RESTART IDENTITY CASCADE`;
    reposDir = fs.mkdtempSync(join(os.tmpdir(), 'ddw-ingest-'));
    makeFixtureRepo(reposDir, 'repo-a');
  });
  afterEach(async () => {
    await sql.end();
    fs.rmSync(reposDir, { recursive: true, force: true });
  });

  it('creates the family workspace, the notes, their tags and the hubs', async () => {
    runIngest(reposDir, 'repo-a');

    const [ws] = await sql<{ id: string }[]>`
      SELECT id FROM spaces WHERE name = 'familia-test'`;
    expect(ws).toBeTruthy();

    const notes = await sql<{ title: string }[]>`
      SELECT title FROM notes WHERE space_id = ${ws.id} ORDER BY title`;
    const titles = notes.map((n) => n.title);
    expect(titles).toContain('DDW · repo-a · docs/adr/adr-001-x.md');
    expect(titles).toContain('DDW · repo-a · docs/ddw/prd/prd-T-1.md');
    expect(titles).toContain('DDW · repo-a');
    expect(titles).toContain('DDW · familia familia-test');

    const tags = await sql<{ tag: string }[]>`
      SELECT DISTINCT tag FROM note_tags WHERE space_id = ${ws.id}`;
    const tagSet = new Set(tags.map((t) => t.tag));
    expect(tagSet.has('ddw')).toBe(true);
    expect(tagSet.has('repo/repo-a')).toBe(true);
    expect(tagSet.has('tipo/adr')).toBe(true);
    expect(tagSet.has('familia/familia-test')).toBe(true);
    expect(tagSet.has('ticket/t-1')).toBe(true);

    const links = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM note_links WHERE space_id = ${ws.id}`;
    expect(links[0].n).toBeGreaterThan(0);
  });

  it('is idempotent by blob sha and picks up a changed source', async () => {
    runIngest(reposDir, 'repo-a');
    const countNotes = async () =>
      (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notes`)[0].n;
    const before = await countNotes();

    runIngest(reposDir, 'repo-a');
    expect(await countNotes()).toBe(before);

    fs.appendFileSync(join(reposDir, 'repo-a/docs/adr/adr-001-x.md'), '\nMore.\n');
    runIngest(reposDir, 'repo-a');
    expect(await countNotes()).toBe(before);
    const [adr] = await sql<{ content_md: string }[]>`
      SELECT content_md FROM notes WHERE title = 'DDW · repo-a · docs/adr/adr-001-x.md'`;
    expect(adr.content_md).toContain('More.');
  });

  it('annotates — never trashes — the note of a vanished source', async () => {
    runIngest(reposDir, 'repo-a');
    fs.rmSync(join(reposDir, 'repo-a/docs/adr/adr-001-x.md'));
    runIngest(reposDir, 'repo-a');

    const [adr] = await sql<{ content_md: string; deleted_at: string | null }[]>`
      SELECT content_md, deleted_at FROM notes
      WHERE title = 'DDW · repo-a · docs/adr/adr-001-x.md'`;
    expect(adr).toBeTruthy();
    expect(adr.deleted_at).toBeNull();
    expect(adr.content_md).toContain('estado/archivado');

    // …and the annotation is appended exactly once.
    runIngest(reposDir, 'repo-a');
    const [again] = await sql<{ content_md: string }[]>`
      SELECT content_md FROM notes WHERE title = 'DDW · repo-a · docs/adr/adr-001-x.md'`;
    expect(again.content_md.match(/estado\/archivado/g)?.length).toBe(1);
  });

  it('refuses to clobber a note it did not write, even on a title collision', async () => {
    // The connector namespaces its titles (`DDW · <repo> · <path>`), so a
    // collision takes effort — but the failure it guards is silent and
    // destructive, which is the combination worth pinning. The archive pass
    // always checked the source footer before touching a note; the write path
    // did not, so anything sitting on the title lost its whole body.
    //
    // Modelled by taking a note the connector DID create and replacing its
    // body with hand-written text (which drops the footer), then changing the
    // source so the next run wants to update it.
    const title = 'DDW · repo-a · docs/adr/adr-001-x.md';
    runIngest(reposDir, 'repo-a');

    const mine = 'escrito a mano, sin footer del conector';
    await sql`UPDATE notes SET content_md = ${mine} WHERE title = ${title}`;

    fs.appendFileSync(join(reposDir, 'repo-a/docs/adr/adr-001-x.md'), '\nCambio.\n');
    runIngest(reposDir, 'repo-a');

    const rows = await sql<{ content_md: string }[]>`
      SELECT content_md FROM notes WHERE title = ${title}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].content_md).toBe(mine);
  });
});
