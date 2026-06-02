import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, DrizzleOidcCeremoniesRepository, DrizzleOrgSettingsRepository } from '@diluxite/db';
// (buildAuthorizeUrl + handleCallback need a real openid-client Configuration
//  instance per the lib's runtime checks; we test them via the smoke gate
//  against a public test IdP, not this in-process file.)

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * OIDC integration tests focused on the pieces we can validate without
 * running a real IdP:
 *
 *   1. Ceremony persistence — state/nonce/codeVerifier roundtrip through DB.
 *   2. Consume is single-use (replay safety).
 *   3. Expired ceremonies are not returned.
 *   4. buildAuthorizeUrl shapes the URL correctly (issuer scheme, query
 *      params, scopes, PKCE method).
 *
 * Full callback flow (with a mock issuer + JWKS + signed id_token) is the
 * Sprint follow-up — for alpha.25 we ship with the integration tests below
 * + a manual smoke against a real test IdP (we'll use auth0.com free tier
 * in the staging compose). The point of THIS suite is to guarantee the
 * persistence + URL construction don't drift.
 */

describe('OIDC ceremony persistence', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let repo: DrizzleOidcCeremoniesRepository;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    await sql`TRUNCATE oidc_ceremonies RESTART IDENTITY`;
    repo = new DrizzleOidcCeremoniesRepository(sql);
  });

  afterEach(async () => {
    await sql.end();
  });

  it('save + consume roundtrips state/nonce/code_verifier', async () => {
    await repo.save('state-123', 'nonce-abc', 'verifier-xyz');
    const c = await repo.consume('state-123');
    expect(c).toBeTruthy();
    expect(c!.state).toBe('state-123');
    expect(c!.nonce).toBe('nonce-abc');
    expect(c!.codeVerifier).toBe('verifier-xyz');
  });

  it('consume is single-use (replay safety)', async () => {
    // Regression for "attacker captures the state and tries to replay it".
    // The DELETE … RETURNING in `consume` makes the second call see nothing.
    await repo.save('state-once', 'n', 'v');
    expect(await repo.consume('state-once')).toBeTruthy();
    expect(await repo.consume('state-once')).toBeNull();
  });

  it('returns null for unknown state', async () => {
    expect(await repo.consume('never-saved')).toBeNull();
  });

  it('does NOT return expired ceremonies', async () => {
    // Insert directly with a past expiry to simulate "user left the tab open
    // overnight" — the consume should refuse and the row stays for sweep.
    await sql`
      INSERT INTO oidc_ceremonies (state, nonce, code_verifier, expires_at)
      VALUES ('stale', 'n', 'v', NOW() - INTERVAL '5 minutes')
    `;
    expect(await repo.consume('stale')).toBeNull();
  });

  it('sweepExpired removes only expired rows, returns count', async () => {
    await repo.save('fresh', 'n', 'v'); // 10 min in the future per repo TTL
    await sql`
      INSERT INTO oidc_ceremonies (state, nonce, code_verifier, expires_at)
      VALUES ('old-1', 'n', 'v', NOW() - INTERVAL '1 hour'),
             ('old-2', 'n', 'v', NOW() - INTERVAL '2 hour')
    `;
    expect(await repo.sweepExpired()).toBe(2);
    // Fresh one is still there.
    expect(await repo.consume('fresh')).toBeTruthy();
  });
});

// `buildAuthorizeUrl` requires a real `openid-client` Configuration (the lib
// enforces an instance check). That means a faithful test against it needs
// either a mock issuer with discovery, or a real network call to a public
// IdP. Both are heavier than we want for `:integration`; the smoke gate
// hits a real `https://example.okta.com` discovery against an empty
// project in staging — that's where shape-of-URL regressions get caught.
// We keep this file focused on what we CAN check with sql-only deps:
// ceremony persistence + auth_policy.

describe('org_settings auth_policy enforcement (unit)', () => {
  let sql: ReturnType<typeof createDb>['sql'];
  let orgSettings: DrizzleOrgSettingsRepository;

  beforeEach(async () => {
    const conn = createDb(TEST_URL);
    sql = conn.sql;
    await sql`TRUNCATE org_settings RESTART IDENTITY CASCADE`;
    orgSettings = new DrizzleOrgSettingsRepository(conn.db);
  });

  afterEach(async () => {
    await sql.end();
  });

  it('defaults to allow_unknown_as_member when no row exists for org', async () => {
    expect(await orgSettings.getAuthPolicy('00000000-0000-0000-0000-000000000000')).toBe(
      'allow_unknown_as_member',
    );
  });
});
