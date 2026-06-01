import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { StoredTokenAuthProvider } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleTokensRepository } from './tokens-repository';
import { DrizzleUsersRepository } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Per-user tokens (integration)', () => {
  let tokensRepo: DrizzleTokensRepository;
  let userId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    const users = new DrizzleUsersRepository(db);
    userId = (await users.create('a@diluxite')).id;
    tokensRepo = new DrizzleTokensRepository(db);
  });

  it('creates a token and verifies it by hash', async () => {
    const { token, info } = await tokensRepo.create(userId, 'claude');
    expect(token).toBeTruthy();
    expect(info.name).toBe('claude');
    expect(await tokensRepo.findUserIdByToken(token)).toBe(userId);
    expect(await tokensRepo.findUserIdByToken('invalid')).toBeNull();
  });

  it('StoredTokenAuthProvider resolves the freshly minted token', async () => {
    const { token } = await tokensRepo.create(userId);
    const provider = new StoredTokenAuthProvider(tokensRepo);
    expect(await provider.resolve({ authorization: `Bearer ${token}` })).toEqual({ userId });
  });

  it('lists and revokes tokens', async () => {
    const { token, info } = await tokensRepo.create(userId, 'a');
    await tokensRepo.create(userId, 'b');
    expect(await tokensRepo.list(userId)).toHaveLength(2);
    expect(await tokensRepo.revoke(userId, info.id)).toBe(true);
    expect(await tokensRepo.findUserIdByToken(token)).toBeNull();
    expect(await tokensRepo.list(userId)).toHaveLength(1);
  });

  it('does not revoke another user\'s tokens', async () => {
    const other = (await new DrizzleUsersRepository(db).create('b@diluxite')).id;
    const { info } = await tokensRepo.create(userId, 'mine');
    expect(await tokensRepo.revoke(other, info.id)).toBe(false);
  });

  it('user tokens come back with empty scopes by default (legacy behaviour)', async () => {
    await tokensRepo.create(userId, 'legacy');
    const list = await tokensRepo.list(userId);
    expect(list[0].scopes).toEqual([]);
  });

  it('resolveToken returns user / null orgId for a user token', async () => {
    const { token } = await tokensRepo.create(userId);
    const resolved = await tokensRepo.resolveToken(token);
    expect(resolved).toMatchObject({ userId, orgId: null, scopes: [] });
    expect(await tokensRepo.resolveToken('nope')).toBeNull();
  });
});

describe('Org-scoped tokens (integration)', () => {
  let tokensRepo: DrizzleTokensRepository;
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    const users = new DrizzleUsersRepository(db);
    userId = (await users.create('admin@diluxite')).id;
    const { DrizzleOrganizationsRepository } = await import('./organizations-repository');
    const orgs = new DrizzleOrganizationsRepository(db);
    orgId = (await orgs.create('Acme', 'acme', userId)).id;
    tokensRepo = new DrizzleTokensRepository(db);
  });

  it('createOrgToken requires at least one scope', async () => {
    await expect(tokensRepo.createOrgToken(orgId, 't', [])).rejects.toThrow(/scope/);
  });

  it('createOrgToken returns cleartext + persists scopes', async () => {
    const { token, info } = await tokensRepo.createOrgToken(orgId, 'ci', ['read', 'write']);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(info.scopes).toEqual(['read', 'write']);
  });

  it('listForOrg returns ONLY org tokens (no user tokens leak in)', async () => {
    await tokensRepo.create(userId, 'user-token');
    await tokensRepo.createOrgToken(orgId, 'org-token', ['read']);
    const orgList = await tokensRepo.listForOrg(orgId);
    expect(orgList).toHaveLength(1);
    expect(orgList[0].name).toBe('org-token');
    expect(orgList[0].scopes).toEqual(['read']);
  });

  it('list() (user tokens) does NOT leak org tokens', async () => {
    await tokensRepo.createOrgToken(orgId, 'org-only', ['read']);
    expect(await tokensRepo.list(userId)).toEqual([]);
  });

  it('resolveToken returns orgId / null userId for an org token', async () => {
    const { token } = await tokensRepo.createOrgToken(orgId, 'svc', ['read', 'space:abc']);
    const resolved = await tokensRepo.resolveToken(token);
    expect(resolved).toMatchObject({ userId: null, orgId, scopes: ['read', 'space:abc'] });
  });

  it('revokeOrgToken removes the token; cross-org revoke fails', async () => {
    const { info } = await tokensRepo.createOrgToken(orgId, 'a', ['read']);
    const { DrizzleOrganizationsRepository } = await import('./organizations-repository');
    const otherOrg = (await new DrizzleOrganizationsRepository(db).create('Beta', 'beta', userId))
      .id;
    expect(await tokensRepo.revokeOrgToken(otherOrg, info.id)).toBe(false);
    expect(await tokensRepo.listForOrg(orgId)).toHaveLength(1);
    expect(await tokensRepo.revokeOrgToken(orgId, info.id)).toBe(true);
    expect(await tokensRepo.listForOrg(orgId)).toHaveLength(0);
  });

  it('findUserIdByToken does NOT match org tokens (legacy auth ignores them)', async () => {
    const { token } = await tokensRepo.createOrgToken(orgId, 'org', ['read']);
    expect(await tokensRepo.findUserIdByToken(token)).toBeNull();
  });
});
