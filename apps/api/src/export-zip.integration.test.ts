import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

/**
 * `GET /api/spaces/:id/export.zip` — the workspace as Markdown files.
 *
 * The archive is read back with **Python's `zipfile`**, not with the library
 * that wrote it. A reader and a writer from the same package agree with each
 * other by construction: they would agree on a malformed archive too, and
 * this endpoint's only promise is that other software can open it. `python3`
 * is required, not optional — a check that skips when its tool is missing is
 * a check that reports green while testing nothing.
 */

const PY = (script: string, ...args: string[]): string =>
  execFileSync('python3', ['-c', script, ...args], { encoding: 'utf8' });

describe('workspace export', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let dir: string;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    dir = mkdtempSync(join(tmpdir(), 'diluxite-export-'));
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await app.close();
    await sql.end();
  });

  const createNote = async (title: string, contentMd: string, folderId?: string) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd, folderId },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  const createFolder = async (name: string, parentId: string | null = null) => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name, parentId },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };

  /** Download the archive and hand it to Python. Returns the temp file path. */
  const download = async (): Promise<{ path: string; headers: Record<string, unknown> }> => {
    const r = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/export.zip` });
    expect(r.statusCode).toBe(200);
    const path = join(dir, 'export.zip');
    writeFileSync(path, r.rawPayload);
    return { path, headers: r.headers as Record<string, unknown> };
  };

  const namelist = (path: string): string[] =>
    PY('import sys,zipfile;print("\\n".join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))', path)
      .trim()
      .split('\n')
      .filter(Boolean);

  const read = (path: string, entry: string): string =>
    PY(
      'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode("utf-8"),end="")',
      path,
      entry,
    );

  it('produces an archive other software can open, with the folder tree intact', async () => {
    const projects = await createFolder('Proyectos');
    const inner = await createFolder('Diluxite', projects);
    await createNote('Raíz', '# Raíz\n\nen la raíz\n');
    await createNote('Hija', '# Hija\n\nanidada\n', inner);

    const { path } = await download();
    // `testzip()` returns the first corrupt entry, or None. This is the check
    // that the bytes are a real ZIP and not merely something we can re-read.
    expect(
      PY('import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).testzip())', path).trim(),
    ).toBe('None');
    expect(namelist(path)).toEqual(['Proyectos/Diluxite/Hija.md', 'Raíz.md']);
  });

  it('keeps the body verbatim and puts the metadata in frontmatter', async () => {
    const body = 'ver [[Otra]] y #proyecto\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
    await createNote('Nota', body);

    const { path } = await download();
    const content = read(path, 'Nota.md');
    expect(content.endsWith(body)).toBe(true);
    expect(content).toMatch(/^---\nid: "[0-9a-f-]{36}"\ntitle: "Nota"\n/);
  });

  it('round-trips non-ASCII in both the filename and the body', async () => {
    // The entry name and the content are separately encoded in a ZIP, and an
    // archive that mangles either is unusable in Spanish.
    await createNote('Métricas — año 2026', '# Métricas\n\nacentos: ñ á é í ó ú ü\n');
    const { path } = await download();
    expect(namelist(path)).toEqual(['Métricas — año 2026.md']);
    expect(read(path, 'Métricas — año 2026.md')).toContain('ñ á é í ó ú ü');
  });

  it('cannot be made to write outside the folder it is unzipped into', async () => {
    await createNote('../../etc/passwd', 'nope\n');
    const { path } = await download();
    const [entry] = namelist(path);
    expect(entry).toBe('..-..-etc-passwd.md');
    // Python's `extractall` sanitises, so the assertion is on the entry name
    // itself: no separator, no parent segment, nothing absolute.
    expect(entry.includes('/')).toBe(false);
    expect(entry.startsWith('/')).toBe(false);
  });

  it('does not let sanitisation collapse two notes into a single file', async () => {
    // Two DISTINCT live notes — titles are unique per space — whose names
    // both reduce to `Reunión-Q3` once the separator is cleaned out.
    await createNote('Reunión/Q3', 'primera\n');
    await createNote('Reunión-Q3', 'segunda\n');
    const { path } = await download();
    const names = namelist(path);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    const bodies = names.map((n) => read(path, n));
    expect(bodies.some((b) => b.endsWith('primera\n'))).toBe(true);
    expect(bodies.some((b) => b.endsWith('segunda\n'))).toBe(true);
  });

  it('leaves trashed notes out — Trash is where they are', async () => {
    const keep = await createNote('Viva', 'sigo acá\n');
    const gone = await createNote('Borrada', 'a la papelera\n');
    await app.inject({ method: 'DELETE', url: `/api/notes/${gone}` });

    const { path } = await download();
    expect(namelist(path)).toEqual(['Viva.md']);
    expect(keep).toBeTruthy();
  });

  it('names the download after the workspace, safely', async () => {
    await createNote('Nota', 'x\n');
    const { headers } = await download();
    expect(headers['content-type']).toBe('application/zip');
    const cd = String(headers['content-disposition']);
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    // Neither half may carry a quote or a backslash out of the header.
    expect(cd.slice(0, cd.indexOf('; filename*'))).not.toMatch(/[\\]/);
  });

  it('exports an empty workspace as a valid, empty archive', async () => {
    const { path } = await download();
    expect(namelist(path)).toEqual([]);
  });

  it('a repeated title is a 409, not a 500', async () => {
    // Found while writing the collision test above: the unique index from
    // migration 0020 escaped as `internal server error`, which tells the
    // caller nothing about the one thing they can change.
    await createNote('Única', 'primera\n');
    const again = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Única', contentMd: 'segunda\n' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('note.titleTaken');
  });

  it('refuses a space the caller cannot read', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/spaces/00000000-0000-0000-0000-000000000000/export.zip',
    });
    expect(r.statusCode).toBe(403);
  });
});
