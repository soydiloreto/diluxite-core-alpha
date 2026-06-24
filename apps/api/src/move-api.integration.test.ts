import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildTestApp } from '../test/helpers';

describe('POST /api/spaces/:spaceId/move — bulk multi-select move (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;

  async function folder(name: string, parentId?: string) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/folders`,
      payload: { name, parentId },
    });
    return r.json().id as string;
  }
  async function note(title: string, folderId?: string) {
    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title, contentMd: '', folderId },
    });
    return r.json().id as string;
  }
  async function move(payload: Record<string, unknown>) {
    return await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/move`, payload });
  }
  async function folderOf(noteId: string) {
    return (await app.inject({ url: `/api/notes/${noteId}` })).json().folderId as string | null;
  }
  async function parentOf(folderId: string) {
    const list = (await app.inject({ url: `/api/spaces/${spaceId}/folders` })).json() as {
      id: string;
      parentId: string | null;
    }[];
    return list.find((f) => f.id === folderId)?.parentId ?? null;
  }

  beforeEach(async () => {
    ({ app, sql, defaultSpaceId: spaceId } = await buildTestApp());
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  it('moves a mixed selection of notes and folders into a destination', async () => {
    const dest = await folder('Dest');
    const f = await folder('f');
    const n1 = await note('n1');
    const n2 = await note('n2');

    const r = await move({ targetFolderId: dest, noteIds: [n1, n2], folderIds: [f] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ movedNotes: 2, movedFolders: 1 });

    expect(await folderOf(n1)).toBe(dest);
    expect(await folderOf(n2)).toBe(dest);
    expect(await parentOf(f)).toBe(dest);
  });

  it('moves a selection to the root with a null destination', async () => {
    const parent = await folder('parent');
    const child = await folder('child', parent);
    const n = await note('n', parent);

    const r = await move({ targetFolderId: null, noteIds: [n], folderIds: [child] });
    expect(r.statusCode).toBe(200);
    expect(await folderOf(n)).toBeNull();
    expect(await parentOf(child)).toBeNull();
  });

  it('rejects a folder cycle with 409 and changes nothing', async () => {
    const parent = await folder('parent');
    const child = await folder('child', parent);
    const n = await note('n');

    const r = await move({ targetFolderId: child, noteIds: [n], folderIds: [parent] });
    expect(r.statusCode).toBe(409);
    // Atomic: the note batched alongside the bad folder move must not have moved.
    expect(await folderOf(n)).toBeNull();
    expect(await parentOf(parent)).toBeNull();
  });

  it('400 when nothing is selected', async () => {
    const r = await move({ targetFolderId: null, noteIds: [], folderIds: [] });
    expect(r.statusCode).toBe(400);
  });

  it('400 when noteIds is not an array of strings', async () => {
    const r = await move({ targetFolderId: null, noteIds: [123], folderIds: [] });
    expect(r.statusCode).toBe(400);
  });

  it('400 when targetFolderId is not a string', async () => {
    const n = await note('n');
    const r = await move({ targetFolderId: 42, noteIds: [n], folderIds: [] });
    expect(r.statusCode).toBe(400);
  });

  it('400 when the destination folder does not exist in this space', async () => {
    const n = await note('n');
    const r = await move({
      targetFolderId: '00000000-0000-0000-0000-000000000000',
      noteIds: [n],
      folderIds: [],
    });
    expect(r.statusCode).toBe(400);
    expect(await folderOf(n)).toBeNull();
  });
});
