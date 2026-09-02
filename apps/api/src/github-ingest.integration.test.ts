import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';
import type { AppDeps } from './app';
import { ingestRepo, githubNoteTitle } from './github-ingest';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

/**
 * Ingestion v1.1 against a stubbed GitHub. The rules under test are the three
 * carried over from the DDW connector: incremental by blob sha, a vanished
 * source is annotated rather than trashed, and writes look like any other note.
 */
describe('github ingestion (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let deps: AppDeps;
  let spaceId: string;
  let orgId: string;

  const CREDS = { appId: '1', privateKeyPem: PEM };

  /** A GitHub that answers with the tree and blobs a test declares. */
  function githubWith(tree: { path: string; sha: string; size?: number }[], blobs: Record<string, string>) {
    return vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/access_tokens'))
        return { ok: true, status: 201, json: async () => ({ token: 'tok', expires_at: 'x' }) };
      if (u.includes('/git/trees/'))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tree: tree.map((t) => ({ ...t, type: 'blob' })),
            truncated: false,
          }),
        };
      if (u.includes('/git/blobs/')) {
        const sha = u.split('/git/blobs/')[1];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: Buffer.from(blobs[sha] ?? '').toString('base64'),
            encoding: 'base64',
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  const run = (fetchImpl: typeof fetch) =>
    ingestRepo(deps, {
      orgId,
      spaceId,
      fullName: 'acme/docs',
      ref: 'main',
      credentials: CREDS,
      installationId: '42',
      fetchImpl,
    });

  beforeEach(async () => {
    ({ app, sql, deps, defaultSpaceId: spaceId, defaultOrgId: orgId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('ingests markdown as ordinary notes, with their source recorded', async () => {
    const r = await run(
      githubWith(
        [
          { path: 'docs/adr.md', sha: 'sha1' },
          { path: 'src/index.ts', sha: 'sha2' },
        ],
        { sha1: '# Una decisión\n\ncuerpo' },
      ),
    );
    expect(r.created).toBe(1);

    const note = await deps.notes.getByTitle(spaceId, githubNoteTitle('acme/docs', 'docs/adr.md'));
    expect(note?.contentMd).toContain('# Una decisión');
    // Tags ride the text, which is how Diluxite derives them.
    expect(note?.contentMd).toContain('#repo/docs');
    expect(note?.contentMd).toContain('blob=sha1');
    // Code is not documentation: a repo of TypeScript costs one tree listing.
    expect(await deps.notes.getByTitle(spaceId, githubNoteTitle('acme/docs', 'src/index.ts'))).toBeNull();
  });

  it('a second run with nothing changed fetches no blobs at all', async () => {
    const first = githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'uno' });
    await run(first);

    const second = githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'uno' });
    const r = await run(second);
    expect(r.unchanged).toBe(1);
    expect(r.created + r.updated).toBe(0);
    // Git's sha IS the content hash: a matching sha cannot have changed.
    const calls = (second as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/git/blobs/'))).toBe(false);
  });

  it('a changed file is re-read and the note updated in place', async () => {
    await run(githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'viejo' }));
    const r = await run(githubWith([{ path: 'a.md', sha: 'sha2' }], { sha2: 'nuevo' }));
    expect(r.updated).toBe(1);
    const note = await deps.notes.getByTitle(spaceId, githubNoteTitle('acme/docs', 'a.md'));
    expect(note?.contentMd).toContain('nuevo');
    expect(note?.contentMd).not.toContain('viejo');
  });

  it('a file deleted from the repo is ANNOTATED, never trashed', async () => {
    await run(githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'contenido' }));
    const r = await run(githubWith([], {}));

    expect(r.annotated).toBe(1);
    const note = await deps.notes.getByTitle(spaceId, githubNoteTitle('acme/docs', 'a.md'));
    // Deleting it would erase the record that it once said something.
    expect(note).not.toBeNull();
    expect(note!.contentMd).toContain('contenido');
    expect(note!.contentMd).toMatch(/Source removed/i);
  });

  it('annotates once, not on every sync after that', async () => {
    await run(githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'x' }));
    await run(githubWith([], {}));
    const again = await run(githubWith([], {}));
    expect(again.annotated).toBe(0);
  });

  it('skips a file too large to be a document', async () => {
    const r = await run(
      githubWith([{ path: 'huge.md', sha: 'sha1', size: 5_000_000 }], { sha1: 'x' }),
    );
    expect(r.skipped).toEqual(['huge.md']);
    expect(r.created).toBe(0);
  });

  it('the ingested note is searchable like any other', async () => {
    await run(githubWith([{ path: 'a.md', sha: 'sha1' }], { sha1: 'pgvector y embeddings' }));
    const hits = await deps.search.search(spaceId, 'pgvector', 5, 'keyword');
    expect(hits.some((h) => h.title.includes('a.md'))).toBe(true);
  });

  it('refuses a repository name that is not one, instead of walking the API', async () => {
    // The name arrives from a webhook payload. Dropped into a path unchecked,
    // a `..` walks to another endpoint — the request never leaves
    // api.github.com, which is why it is easy to wave away, and it still
    // reaches something nobody meant to expose.
    const f = githubWith([], {});
    await expect(
      ingestRepo(deps, {
        orgId,
        spaceId,
        fullName: '../../app/installations',
        ref: 'main',
        credentials: CREDS,
        installationId: '42',
        fetchImpl: f,
      }),
    ).rejects.toThrow(/not a repository name/);
  });

  it('refuses an installation id that is not a number', async () => {
    await expect(
      ingestRepo(deps, {
        orgId,
        spaceId,
        fullName: 'acme/docs',
        ref: 'main',
        credentials: CREDS,
        installationId: '1/../../x',
        fetchImpl: githubWith([], {}),
      }),
    ).rejects.toThrow(/not an installation id/);
  });
});
