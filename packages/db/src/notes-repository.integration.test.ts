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

  it('DrizzleSpacesRepository lists the user spaces', async () => {
    const { userId } = await ensureSingleUserBootstrap(db);
    const spaces = await new DrizzleSpacesRepository(db).listForUser(userId);
    expect(spaces.length).toBeGreaterThanOrEqual(1);
  });
});
