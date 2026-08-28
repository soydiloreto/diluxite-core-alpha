import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { DrizzleNoteVersionsRepository } from './note-versions-repository';
import { ensureSingleUserBootstrap } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('DrizzleNoteVersionsRepository (Postgres integration)', () => {
  let spaceId: string;
  let notes: DrizzleNotesRepository;
  let versions: DrizzleNoteVersionsRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
    notes = new DrizzleNotesRepository(db);
    versions = new DrizzleNoteVersionsRepository(db);
  });

  it('records the BEFORE state and lists newest first', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    const rec = await versions.record(n, { coalesceMs: 0 });
    expect(rec?.contentMd).toBe('v1');
    await versions.record({ ...n, contentMd: 'v2' }, { coalesceMs: 0 });

    const list = await versions.listForNote(n.id);
    expect(list.map((v) => v.contentMd)).toEqual(['v2', 'v1']);
    expect((await versions.findById(list[1].id))?.contentMd).toBe('v1');
  });

  it('coalesces a burst: within the window only the first snapshot survives', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    expect(await versions.record(n, { coalesceMs: 60_000 })).not.toBeNull();
    // The collab flush two seconds later must NOT mint a second version.
    expect(await versions.record({ ...n, contentMd: 'v1b' }, { coalesceMs: 60_000 })).toBeNull();
    const list = await versions.listForNote(n.id);
    expect(list).toHaveLength(1);
    expect(list[0].contentMd).toBe('v1'); // the state from before the burst
  });

  it('prunes past the cap, oldest first', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: '' });
    for (let i = 1; i <= 5; i++) {
      await versions.record({ ...n, contentMd: `v${i}` }, { coalesceMs: 0, cap: 3 });
    }
    const list = await versions.listForNote(n.id);
    expect(list.map((v) => v.contentMd)).toEqual(['v5', 'v4', 'v3']);
  });

  it('purging the note cascades its history away', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    await versions.record(n, { coalesceMs: 0 });
    await notes.delete(n.id); // soft — history survives the trash
    expect(await versions.listForNote(n.id)).toHaveLength(1);
    await notes.purge(n.id); // hard — FK cascade takes the versions
    expect(await versions.listForNote(n.id)).toHaveLength(0);
  });
});

describe('DrizzleNotesRepository.update — the one door that records history', () => {
  let spaceId: string;
  let notes: DrizzleNotesRepository;
  let versions: DrizzleNoteVersionsRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
    notes = new DrizzleNotesRepository(db);
    versions = new DrizzleNoteVersionsRepository(db);
  });

  it('a content-changing repo update snapshots what the note used to say', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    await notes.update(n.id, { contentMd: 'v2' });
    const list = await versions.listForNote(n.id);
    expect(list).toHaveLength(1);
    expect(list[0].contentMd).toBe('v1'); // the BEFORE state
  });

  it('an immediate second change coalesces (the collab-burst behaviour)', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    await notes.update(n.id, { contentMd: 'v2' });
    await notes.update(n.id, { contentMd: 'v3' }); // ~the 2s collab flush
    const list = await versions.listForNote(n.id);
    expect(list).toHaveLength(1);
    expect(list[0].contentMd).toBe('v1');
  });

  it('retitles, moves and same-content saves record nothing', async () => {
    const n = await notes.create({ spaceId, title: 'T', contentMd: 'v1' });
    await notes.update(n.id, { title: 'T2' });
    await notes.update(n.id, { folderId: null });
    await notes.update(n.id, { contentMd: 'v1' });
    expect(await versions.listForNote(n.id)).toHaveLength(0);
  });
});
