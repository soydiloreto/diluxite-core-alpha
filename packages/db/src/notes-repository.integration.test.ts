import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { NotesService } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleNotesRepository } from './notes-repository';
import { ensureSingleUserBootstrap, DrizzleSpacesRepository } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('DrizzleNotesRepository (Postgres integration)', () => {
  let spaceId: string;
  let repo: DrizzleNotesRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
    repo = new DrizzleNotesRepository(db);
  });

  it('bootstrap is idempotent', async () => {
    const a = await ensureSingleUserBootstrap(db);
    const b = await ensureSingleUserBootstrap(db);
    expect(a.userId).toBe(b.userId);
    expect(a.spaceId).toBe(b.spaceId);
  });

  it('creates and reads by id', async () => {
    const n = await repo.create({ spaceId, title: 'Azure', contentMd: 'the cloud' });
    expect(n.id).toBeTruthy();
    expect(n.createdAt).toBeInstanceOf(Date);
    const got = await repo.findById(n.id);
    expect(got?.title).toBe('Azure');
  });

  it('lists per space ordered by updatedAt desc', async () => {
    await repo.create({ spaceId, title: 'old', contentMd: '' });
    const fresh = await repo.create({ spaceId, title: 'new', contentMd: '' });
    const list = await repo.list(spaceId);
    expect(list[0].id).toBe(fresh.id);
    expect(list).toHaveLength(2);
  });

  it('updates and deletes', async () => {
    const n = await repo.create({ spaceId, title: 'T', contentMd: 'v1' });
    const upd = await repo.update(n.id, { contentMd: 'v2' });
    expect(upd?.contentMd).toBe('v2');
    expect(await repo.delete(n.id)).toBe(true);
    expect(await repo.findById(n.id)).toBeNull();
  });

  it('findByTitle scopes to the space', async () => {
    await repo.create({ spaceId, title: 'Unique', contentMd: '' });
    expect((await repo.findByTitle(spaceId, 'Unique'))?.title).toBe('Unique');
    expect(await repo.findByTitle(spaceId, 'missing')).toBeNull();
  });

  it('works as a NotesRepository for NotesService (openOrCreate)', async () => {
    const svc = new NotesService(repo);
    const a = await svc.openOrCreate(spaceId, 'MUG');
    const b = await svc.openOrCreate(spaceId, 'MUG');
    expect(b.id).toBe(a.id);
  });

  it('concurrent openOrCreate of the same title yields a single note (TOCTOU)', async () => {
    const svc = new NotesService(repo);
    // Two racing wikilink follows. Without the atomic upsert + UNIQUE index
    // both would insert and we'd end up with two notes titled "Nota Nueva".
    const [a, b] = await Promise.all([
      svc.openOrCreate(spaceId, 'Nota Nueva'),
      svc.openOrCreate(spaceId, 'Nota Nueva'),
    ]);
    expect(a.id).toBe(b.id);
    const all = (await repo.list(spaceId)).filter((n) => n.title === 'Nota Nueva');
    expect(all).toHaveLength(1);
  });

  it('createIfAbsent reports created=true only on first insert', async () => {
    const first = await repo.createIfAbsent({ spaceId, title: 'Once', contentMd: 'x' });
    expect(first.created).toBe(true);
    const second = await repo.createIfAbsent({ spaceId, title: 'Once', contentMd: 'y' });
    expect(second.created).toBe(false);
    expect(second.note.id).toBe(first.note.id);
    // The conflicting insert did NOT overwrite the original content.
    expect(second.note.contentMd).toBe('x');
  });

  it('a title freed by trashing can be reused by createIfAbsent', async () => {
    const a = await repo.createIfAbsent({ spaceId, title: 'Reusable', contentMd: '1' });
    await repo.delete(a.note.id); // soft-delete frees the partial-unique slot
    const b = await repo.createIfAbsent({ spaceId, title: 'Reusable', contentMd: '2' });
    expect(b.created).toBe(true);
    expect(b.note.id).not.toBe(a.note.id);
  });

  it('DrizzleSpacesRepository lists the user spaces', async () => {
    const { userId } = await ensureSingleUserBootstrap(db);
    const spaces = await new DrizzleSpacesRepository(db).listForUser(userId);
    expect(spaces.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the order notes come back in is stable', () => {
  /**
   * `list` sorted by `updated_at DESC` and nothing else, and ties are not
   * rare: `updated_at` defaults to `now()`, which in Postgres is the
   * transaction's START time, so every note written in one transaction —
   * an import, a batch MCP write, a bulk move — carries the identical
   * timestamp. With no tiebreaker the order among them is whatever the
   * planner returns, and it may differ between two identical requests.
   *
   * In the explorer that reads as items shuffling for no reason. In the test
   * suite it read as an occasional flake, which is how it was filed.
   *
   * The rows here are inserted with chosen ids in ascending order, so the
   * physical order is the exact opposite of the promised one — a sort that
   * only looks at `updated_at` cannot land on it by luck.
   */
  const sameInstant = '2026-03-01 12:00:00';
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];

  let spaceId: string;
  let repo: DrizzleNotesRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    ({ spaceId } = await ensureSingleUserBootstrap(db));
    repo = new DrizzleNotesRepository(db);
    for (const [i, id] of ids.entries()) {
      await sql`
        INSERT INTO notes (id, space_id, title, content_md, created_at, updated_at)
        VALUES (${id}, ${spaceId}, ${`tied-${i}`}, '', ${sameInstant}, ${sameInstant})`;
    }
  });

  it('notes written in the same transaction have a defined order', async () => {
    const listed = await repo.list(spaceId);
    expect(listed.map((n) => n.id)).toEqual([...ids].reverse());
  });

  it('and asking twice returns the same order', async () => {
    const a = await repo.list(spaceId);
    const b = await repo.list(spaceId);
    expect(b.map((n) => n.id)).toEqual(a.map((n) => n.id));
  });

  it('the trash orders the same way — a bulk delete shares one `deleted_at`', async () => {
    await sql`UPDATE notes SET deleted_at = ${sameInstant} WHERE space_id = ${spaceId}`;
    const listed = await repo.listDeleted(spaceId);
    expect(listed.map((n) => n.id)).toEqual([...ids].reverse());
  });
});
