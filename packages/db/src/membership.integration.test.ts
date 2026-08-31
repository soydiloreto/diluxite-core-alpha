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

  it('space create is atomic: a failure leaves no space without a member', async () => {
    const a = await users.create('a@diluxite');
    const before = await spaces.listForOrg(orgId);
    // Non-existent ownerId → FK violation; the transaction must roll back so
    // no half-created space (one without its admin membership) survives.
    const ghost = '00000000-0000-0000-0000-0000000000ff';
    await expect(spaces.create(orgId, 'Doomed', ghost)).rejects.toThrow();
    const after = await spaces.listForOrg(orgId);
    expect(after.length).toBe(before.length);
    // Sanity: the happy path still creates space + admin membership together.
    const ok = await spaces.create(orgId, 'Fine', a.id);
    expect(await spaces.isMember(ok.id, a.id)).toBe(true);
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

  it('creator becomes org_admin of the new org', async () => {
    const founder = await users.create('founder@diluxite');
    const org = await orgs.create('Acme', 'acme', founder.id);
    expect(await orgs.roleOf(org.id, founder.id)).toBe('org_admin');
  });

  it('addOrUpdateMember + listForUser return the right role', async () => {
    const founder = await users.create('founder@diluxite');
    const teammate = await users.create('mate@diluxite');
    const org = await orgs.create('Acme', 'acme2', founder.id);
    await orgs.addOrUpdateMember(org.id, teammate.id, 'org_admin');
    const list = await orgs.listForUser(teammate.id);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe('org_admin');
  });

  it('wouldOrphanLastAdmin protects the last org_admin', async () => {
    const a = await users.create('a@diluxite');
    const b = await users.create('b@diluxite');
    const org = await orgs.create('Acme', 'acme3', a.id);
    // Only `a` is org_admin.
    expect(await orgs.wouldOrphanLastAdmin(org.id, a.id)).toBe(true);
    // Promote `b`; now removing `a` would not orphan.
    await orgs.addOrUpdateMember(org.id, b.id, 'org_admin');
    expect(await orgs.wouldOrphanLastAdmin(org.id, a.id)).toBe(false);
  });

  it('removeMemberGuarded refuses to orphan the last org_admin', async () => {
    const a = await users.create('a@diluxite');
    const org = await orgs.create('Acme', 'acme4', a.id);
    expect(await orgs.removeMemberGuarded(org.id, a.id)).toBe('would_orphan');
    // `a` is still there.
    expect(await orgs.roleOf(org.id, a.id)).toBe('org_admin');
  });

  it('demoteMemberGuarded refuses to demote the last org_admin', async () => {
    const a = await users.create('a@diluxite');
    const org = await orgs.create('Acme', 'acme5', a.id);
    expect(await orgs.demoteMemberGuarded(org.id, a.id, 'org_member')).toBe('would_orphan');
    expect(await orgs.roleOf(org.id, a.id)).toBe('org_admin');
    // With a second org_admin the demotion is allowed.
    const b = await users.create('b@diluxite');
    await orgs.addOrUpdateMember(org.id, b.id, 'org_admin');
    expect(await orgs.demoteMemberGuarded(org.id, a.id, 'org_member')).toBe('updated');
    expect(await orgs.roleOf(org.id, a.id)).toBe('org_member');
  });

  it('concurrent guarded demotes can never both orphan the org', async () => {
    // Two org_admins, two racing demotes. The FOR UPDATE lock serialises
    // them: exactly one wins, the other sees the (now sole) org_admin and
    // is refused. The org always keeps at least one org_admin.
    const a = await users.create('a@diluxite');
    const b = await users.create('b@diluxite');
    const org = await orgs.create('Acme', 'acme6', a.id);
    await orgs.addOrUpdateMember(org.id, b.id, 'org_admin');
    const [ra, rb] = await Promise.all([
      orgs.demoteMemberGuarded(org.id, a.id, 'org_member'),
      orgs.demoteMemberGuarded(org.id, b.id, 'org_member'),
    ]);
    const outcomes = [ra, rb].sort();
    expect(outcomes).toEqual(['updated', 'would_orphan']);
    const remaining = (await orgs.members(org.id)).filter((m) => m.role === 'org_admin');
    expect(remaining).toHaveLength(1);
  });

  it('create rolls back both inserts atomically on failure', async () => {
    // Duplicate slug → unique violation on the SECOND statement path. The
    // whole transaction rolls back: no orphan org without a org_admin.
    const a = await users.create('a@diluxite');
    await orgs.create('Acme', 'dup-slug', a.id);
    const before = (await orgs.listForUser(a.id)).length;
    await expect(orgs.create('Acme2', 'dup-slug', a.id)).rejects.toThrow();
    const after = (await orgs.listForUser(a.id)).length;
    expect(after).toBe(before); // no partial org created
  });
});
