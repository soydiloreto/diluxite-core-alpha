import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { DrizzleFoldersRepository } from './folders-repository';
import { DrizzleMoveRepository, FolderCycleError } from './move-repository';
import { DrizzleSpacesRepository, ensureSingleUserBootstrap } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('DrizzleMoveRepository (Postgres integration)', () => {
  let spaceId: string;
  let orgId: string;
  let userId: string;
  let notes: DrizzleNotesRepository;
  let folders: DrizzleFoldersRepository;
  let move: DrizzleMoveRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId, orgId, userId } = await ensureSingleUserBootstrap(db));
    notes = new DrizzleNotesRepository(db);
    folders = new DrizzleFoldersRepository(db);
    move = new DrizzleMoveRepository(db);
  });

  it('moves several notes into a folder in one call', async () => {
    const dest = await folders.create(spaceId, 'Dest', null);
    const a = await notes.create({ spaceId, title: 'a', contentMd: '' });
    const b = await notes.create({ spaceId, title: 'b', contentMd: '' });
    const c = await notes.create({ spaceId, title: 'c', contentMd: '' });

    const res = await move.moveItems({
      spaceId,
      targetFolderId: dest.id,
      noteIds: [a.id, b.id, c.id],
      folderIds: [],
    });

    expect(res).toEqual({ movedNotes: 3, movedFolders: 0 });
    for (const id of [a.id, b.id, c.id]) {
      expect((await notes.findById(id))?.folderId).toBe(dest.id);
    }
  });

  it('moves several folders into a folder', async () => {
    const dest = await folders.create(spaceId, 'Dest', null);
    const f1 = await folders.create(spaceId, 'f1', null);
    const f2 = await folders.create(spaceId, 'f2', null);

    const res = await move.moveItems({
      spaceId,
      targetFolderId: dest.id,
      noteIds: [],
      folderIds: [f1.id, f2.id],
    });

    expect(res).toEqual({ movedNotes: 0, movedFolders: 2 });
    const list = await folders.list(spaceId);
    expect(list.find((f) => f.id === f1.id)?.parentId).toBe(dest.id);
    expect(list.find((f) => f.id === f2.id)?.parentId).toBe(dest.id);
  });

  it('moves a mixed selection of notes and folders together', async () => {
    const dest = await folders.create(spaceId, 'Dest', null);
    const f = await folders.create(spaceId, 'f', null);
    const n = await notes.create({ spaceId, title: 'n', contentMd: '' });

    const res = await move.moveItems({
      spaceId,
      targetFolderId: dest.id,
      noteIds: [n.id],
      folderIds: [f.id],
    });

    expect(res).toEqual({ movedNotes: 1, movedFolders: 1 });
    expect((await notes.findById(n.id))?.folderId).toBe(dest.id);
    expect((await folders.list(spaceId)).find((x) => x.id === f.id)?.parentId).toBe(dest.id);
  });

  it('moves items to the root with a null destination', async () => {
    const parent = await folders.create(spaceId, 'P', null);
    const f = await folders.create(spaceId, 'f', parent.id);
    const n = await notes.create({ spaceId, title: 'n', contentMd: '', folderId: parent.id });

    const res = await move.moveItems({
      spaceId,
      targetFolderId: null,
      noteIds: [n.id],
      folderIds: [f.id],
    });

    expect(res).toEqual({ movedNotes: 1, movedFolders: 1 });
    expect((await notes.findById(n.id))?.folderId).toBeNull();
    expect((await folders.list(spaceId)).find((x) => x.id === f.id)?.parentId).toBeNull();
  });

  it('rejects moving a folder into itself (cycle) and changes nothing', async () => {
    const f = await folders.create(spaceId, 'f', null);
    const n = await notes.create({ spaceId, title: 'n', contentMd: '' });

    await expect(
      move.moveItems({ spaceId, targetFolderId: f.id, noteIds: [n.id], folderIds: [f.id] }),
    ).rejects.toBeInstanceOf(FolderCycleError);

    // Atomic: the note in the SAME batch must not have moved either.
    expect((await notes.findById(n.id))?.folderId).toBeNull();
    expect((await folders.list(spaceId)).find((x) => x.id === f.id)?.parentId).toBeNull();
  });

  it('rejects moving a folder into one of its descendants', async () => {
    const parent = await folders.create(spaceId, 'parent', null);
    const child = await folders.create(spaceId, 'child', parent.id);
    const grandchild = await folders.create(spaceId, 'grandchild', child.id);

    await expect(
      move.moveItems({ spaceId, targetFolderId: grandchild.id, noteIds: [], folderIds: [parent.id] }),
    ).rejects.toBeInstanceOf(FolderCycleError);

    // Tree untouched.
    expect((await folders.list(spaceId)).find((x) => x.id === parent.id)?.parentId).toBeNull();
  });

  it('rejects a destination folder from another space', async () => {
    const spaces = new DrizzleSpacesRepository(db);
    const other = await spaces.create(orgId, 'Other', userId);
    const foreignDest = await folders.create(other.id, 'foreign', null);
    const n = await notes.create({ spaceId, title: 'n', contentMd: '' });

    await expect(
      move.moveItems({ spaceId, targetFolderId: foreignDest.id, noteIds: [n.id], folderIds: [] }),
    ).rejects.toBeInstanceOf(FolderCycleError);
    expect((await notes.findById(n.id))?.folderId).toBeNull();
  });

  it('never touches ids that belong to another space', async () => {
    const spaces = new DrizzleSpacesRepository(db);
    const other = await spaces.create(orgId, 'Other', userId);
    const dest = await folders.create(spaceId, 'Dest', null);
    const mine = await notes.create({ spaceId, title: 'mine', contentMd: '' });
    const foreign = await notes.create({ spaceId: other.id, title: 'foreign', contentMd: '' });

    const res = await move.moveItems({
      spaceId,
      targetFolderId: dest.id,
      noteIds: [mine.id, foreign.id],
      folderIds: [],
    });

    // Only the in-space note moved; the foreign note is untouched.
    expect(res.movedNotes).toBe(1);
    expect((await notes.findById(mine.id))?.folderId).toBe(dest.id);
    expect((await notes.findById(foreign.id))?.folderId).toBeNull();
  });

  it('dedupes repeated ids and no-ops on an empty selection', async () => {
    const dest = await folders.create(spaceId, 'Dest', null);
    const n = await notes.create({ spaceId, title: 'n', contentMd: '' });

    const dup = await move.moveItems({
      spaceId,
      targetFolderId: dest.id,
      noteIds: [n.id, n.id, n.id],
      folderIds: [],
    });
    expect(dup).toEqual({ movedNotes: 1, movedFolders: 0 });

    const empty = await move.moveItems({ spaceId, targetFolderId: null, noteIds: [], folderIds: [] });
    expect(empty).toEqual({ movedNotes: 0, movedFolders: 0 });
  });
});
