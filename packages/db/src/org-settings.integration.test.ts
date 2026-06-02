import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzleOrgSettingsRepository } from './index';
import { ensureSingleUserBootstrap } from './spaces-repository';

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

describe('DrizzleOrgSettingsRepository — auth policy', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let db: ReturnType<typeof createDb>['db'];
  let repo: DrizzleOrgSettingsRepository;
  let orgId: string;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    db = conn.db;
    // Truncate to a known state so the test sees a fresh sparse table.
    await sql`TRUNCATE chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    const bootstrap = await ensureSingleUserBootstrap(db);
    orgId = bootstrap.orgId;
    repo = new DrizzleOrgSettingsRepository(db);
  });

  afterEach(async () => {
    await sql.end();
  });

  it('returns the default policy (allow_unknown_as_member) when no row exists yet', async () => {
    // Important contract: the org_settings table is SPARSE. A brand-new org
    // has no row, and we must NOT fail-closed on read — we fall back to a
    // sensible default so the boot path doesn't deadlock waiting for the
    // admin to make a choice.
    const policy = await repo.getAuthPolicy(orgId);
    expect(policy).toBe('allow_unknown_as_member');
  });

  it('roundtrips deny_unknown', async () => {
    await repo.setAuthPolicy(orgId, 'deny_unknown');
    expect(await repo.getAuthPolicy(orgId)).toBe('deny_unknown');
  });

  it('roundtrips pre_provisioned_only', async () => {
    await repo.setAuthPolicy(orgId, 'pre_provisioned_only');
    expect(await repo.getAuthPolicy(orgId)).toBe('pre_provisioned_only');
  });

  it('setAuthPolicy is idempotent (re-writing the same value is OK)', async () => {
    await repo.setAuthPolicy(orgId, 'deny_unknown');
    await repo.setAuthPolicy(orgId, 'deny_unknown');
    await repo.setAuthPolicy(orgId, 'deny_unknown');
    expect(await repo.getAuthPolicy(orgId)).toBe('deny_unknown');
  });

  it('overwriting a policy persists the latest value', async () => {
    await repo.setAuthPolicy(orgId, 'deny_unknown');
    await repo.setAuthPolicy(orgId, 'pre_provisioned_only');
    await repo.setAuthPolicy(orgId, 'allow_unknown_as_member');
    expect(await repo.getAuthPolicy(orgId)).toBe('allow_unknown_as_member');
  });

  it('CHECK constraint at DB level rejects bogus values', async () => {
    // Raw SQL bypass — verifies that if a buggy code path tries to write
    // garbage, Postgres stops it. Belt-and-braces.
    await expect(
      sql`INSERT INTO org_settings (org_id, auth_policy) VALUES (${orgId}, 'totally_made_up')`,
    ).rejects.toThrow();
  });
});
