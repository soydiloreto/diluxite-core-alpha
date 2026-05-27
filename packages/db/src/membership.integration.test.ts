import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleSpacesRepository, DrizzleUsersRepository } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Memberships + Users (integration)', () => {
  let spaces: DrizzleSpacesRepository;
  let users: DrizzleUsersRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    spaces = new DrizzleSpacesRepository(db);
    users = new DrizzleUsersRepository(db);
  });

  it('owner is a member with the owner role; another user is not until invited', async () => {
    const a = await users.create('a@diluxite');
    const b = await users.create('b@diluxite');
    const space = await spaces.create('Team', a.id);

    expect(await spaces.isMember(space.id, a.id)).toBe(true);
    expect(await spaces.isMember(space.id, b.id)).toBe(false);
    expect(await spaces.role(space.id, a.id)).toBe('owner');

    await spaces.addMember(space.id, b.id);
    expect(await spaces.isMember(space.id, b.id)).toBe(true);
    expect(await spaces.role(space.id, b.id)).toBe('member');
  });

  it('addMember is idempotent', async () => {
    const a = await users.create('a2@diluxite');
    const b = await users.create('b2@diluxite');
    const space = await spaces.create('S', a.id);
    await spaces.addMember(space.id, b.id);
    await spaces.addMember(space.id, b.id);
    expect(await spaces.isMember(space.id, b.id)).toBe(true);
  });

  it('ensureByEmail is idempotent', async () => {
    const u1 = await users.ensureByEmail('c@diluxite');
    const u2 = await users.ensureByEmail('c@diluxite');
    expect(u1.id).toBe(u2.id);
  });

  it('listForUser only returns spaces where the user is a member', async () => {
    const a = await users.create('a3@diluxite');
    const b = await users.create('b3@diluxite');
    const sa = await spaces.create('A space', a.id);
    await spaces.create('B space', b.id);
    const ofA = await spaces.listForUser(a.id);
    expect(ofA.map((s) => s.id)).toEqual([sa.id]);
  });
});
