import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, truncateAll } from '../test/helpers';
import {
  DrizzleSpacesRepository,
  DrizzleUsersRepository,
} from './spaces-repository';
import { DrizzleOrganizationsRepository } from './organizations-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Memberships + Users (integration)', () => {
  let spaces: DrizzleSpacesRepository;
  let users: DrizzleUsersRepository;
  let orgs: DrizzleOrganizationsRepository;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    spaces = new DrizzleSpacesRepository(db);
    users = new DrizzleUsersRepository(db);
    orgs = new DrizzleOrganizationsRepository(db);
    // Every space needs an org now; one shared org per test is enough.
    const founder = await users.create('founder@diluxite');
    const org = await orgs.create('Acme', `acme-${Date.now()}`, founder.id);
    orgId = org.id;
  });

  it('owner is a member with the admin role; another user is not until invited', async () => {
    const a = await users.create('a@diluxite');
    const b = await users.create('b@diluxite');
    const space = await spaces.create(orgId, 'Team', a.id);

    expect(await spaces.isMember(space.id, a.id)).toBe(true);
    expect(await spaces.isMember(space.id, b.id)).toBe(false);
    expect(await spaces.role(space.id, a.id)).toBe('admin');

    await spaces.addOrUpdateMember(space.id, b.id, 'editor');
    expect(await spaces.isMember(space.id, b.id)).toBe(true);
    expect(await spaces.role(space.id, b.id)).toBe('editor');
  });

  it('addOrUpdateMember upserts the role on re-invite', async () => {
    const a = await users.create('a2@diluxite');
    const b = await users.create('b2@diluxite');
    const space = await spaces.create(orgId, 'S', a.id);
    await spaces.addOrUpdateMember(space.id, b.id, 'viewer');
    await spaces.addOrUpdateMember(space.id, b.id, 'editor');
    expect(await spaces.role(space.id, b.id)).toBe('editor');
  });

  it('ensureByEmail is idempotent and lower-cases the email', async () => {
    const u1 = await users.ensureByEmail('C@Diluxite');
    const u2 = await users.ensureByEmail('c@diluxite');
    expect(u1.id).toBe(u2.id);
    expect(u1.email).toBe('c@diluxite');
  });

  it('listForUser only returns spaces where the user is a member', async () => {
    const a = await users.create('a3@diluxite');
    const b = await users.create('b3@diluxite');
    const sa = await spaces.create(orgId, 'A space', a.id);
    await spaces.create(orgId, 'B space', b.id);
    const ofA = await spaces.listForUser(a.id);
    expect(ofA.map((s) => s.id)).toEqual([sa.id]);
  });
});

describe('Organizations + roles (integration)', () => {
  let orgs: DrizzleOrganizationsRepository;
  let users: DrizzleUsersRepository;

  beforeEach(async () => {
    await truncateAll(sql);
    orgs = new DrizzleOrganizationsRepository(db);
    users = new DrizzleUsersRepository(db);
  });

  it('creator becomes super_admin of the new org', async () => {
    const founder = await users.create('founder@diluxite');
    const org = await orgs.create('Acme', 'acme', founder.id);
    expect(await orgs.roleOf(org.id, founder.id)).toBe('super_admin');
  });

  it('addOrUpdateMember + listForUser return the right role', async () => {
    const founder = await users.create('founder@diluxite');
    const teammate = await users.create('mate@diluxite');
    const org = await orgs.create('Acme', 'acme2', founder.id);
    await orgs.addOrUpdateMember(org.id, teammate.id, 'admin');
    const list = await orgs.listForUser(teammate.id);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('admin');
  });

  it('wouldOrphanSuperAdmin protects the last super_admin', async () => {
    const a = await users.create('a@diluxite');
    const b = await users.create('b@diluxite');
    const org = await orgs.create('Acme', 'acme3', a.id);
    // Only `a` is super_admin.
    expect(await orgs.wouldOrphanSuperAdmin(org.id, a.id)).toBe(true);
    // Promote `b`; now removing `a` would not orphan.
    await orgs.addOrUpdateMember(org.id, b.id, 'super_admin');
    expect(await orgs.wouldOrphanSuperAdmin(org.id, a.id)).toBe(false);
  });
});
