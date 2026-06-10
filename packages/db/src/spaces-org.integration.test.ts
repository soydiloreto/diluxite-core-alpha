import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleSpacesRepository, DrizzleUsersRepository } from './spaces-repository';
import { DrizzleOrganizationsRepository } from './organizations-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

/**
 * `isSpaceInOrg` underpins org-token authorisation: an org token has no
 * per-space membership, so its reach is "every space of its org" — and ONLY
 * its org. This guards the cross-org isolation boundary.
 */
describe('DrizzleSpacesRepository.isSpaceInOrg (integration)', () => {
  let spacesRepo: DrizzleSpacesRepository;
  let orgA: string;
  let orgB: string;
  let spaceInA: string;

  beforeEach(async () => {
    await truncateAll(sql);
    const users = new DrizzleUsersRepository(db);
    const orgs = new DrizzleOrganizationsRepository(db);
    spacesRepo = new DrizzleSpacesRepository(db);
    const owner = await users.create('owner@diluxite');
    orgA = (await orgs.create('Acme', `acme-${Date.now()}`, owner.id)).id;
    orgB = (await orgs.create('Beta', `beta-${Date.now()}`, owner.id)).id;
    spaceInA = (await spacesRepo.create(orgA, 'Space A', owner.id)).id;
  });

  it('true when the space belongs to the org', async () => {
    expect(await spacesRepo.isSpaceInOrg(spaceInA, orgA)).toBe(true);
  });

  it('false when the space belongs to a DIFFERENT org (cross-org isolation)', async () => {
    expect(await spacesRepo.isSpaceInOrg(spaceInA, orgB)).toBe(false);
  });

  it('false for an unknown space id', async () => {
    expect(
      await spacesRepo.isSpaceInOrg('00000000-0000-4000-8000-000000000000', orgA),
    ).toBe(false);
  });
});
