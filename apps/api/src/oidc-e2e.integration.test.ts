import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './app';
import { buildTestApp } from '../test/helpers';
import { startMockIssuer, type MockIssuer } from '../test/oidc-mock-issuer';
import { buildOidcClient, type OidcConfig } from './oidc';
import {
  DrizzleOidcCeremoniesRepository,
  DrizzleOrgSettingsRepository,
} from '@diluxite/db';

/**
 * End-to-end OIDC tests.
 *
 *   Diluxite (apps/api buildApp) ←──→ Mock OIDC issuer (test/oidc-mock-issuer)
 *
 * The mock issuer is a real Fastify with /authorize, /token, /jwks.json,
 * /.well-known/openid-configuration. It signs id_tokens with jose against a
 * real RSA keypair. Every test below exercises the FULL flow:
 *
 *   GET /api/auth/oidc/login   (Diluxite)
 *     → 302 to mock-issuer /authorize
 *     → 302 back to Diluxite /api/auth/oidc/callback?code=…
 *     → mock-issuer /token returns a SIGNED id_token
 *     → Diluxite validates JWT vs JWKS, applies policy, mints cookie
 *
 * No JWT shortcut, no `openDirectConnection`-style fake — exactly what a
 * real browser would do against a real Okta/Entra. Catches regressions
 * in: openid-client API, PKCE, nonce, JWKS, policy enforcement, JIT.
 */

interface E2EHandles {
  app: FastifyInstance;
  deps: AppDeps;
  issuer: MockIssuer;
  oidcCfg: OidcConfig;
  authDeps: NonNullable<AppDeps['oidc']>;
  sql: ReturnType<typeof buildTestApp> extends Promise<infer R>
    ? R extends { sql: infer S }
      ? S
      : never
    : never;
}

async function bootE2E(): Promise<E2EHandles> {
  // Mock issuer is http:// localhost — tell openid-client to relax the
  // https-only enforcement just for this process. Production sets/leaves
  // this off.
  process.env.DILUXITE_OIDC_ALLOW_INSECURE = '1';

  // 1. Mock issuer up first.
  const issuer = await startMockIssuer();

  // 2. Reuse the regular test DB + identity setup (creates `local@diluxite`
  //    + default org). We'll graft OIDC onto that org.
  const t = await buildTestApp();

  // 3. Build the OIDC plumbing: discovery + ceremonies repo + org_settings
  //    repo. Then attach to deps.oidc and rebuild the app so the handlers
  //    register their config.rateLimit + the conditional `if (deps.oidc)`
  //    branch wires in.
  const oidcCfg: OidcConfig = {
    issuerUrl: issuer.url,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    redirectUri: 'http://localhost:3030/api/auth/oidc/callback',
    scopes: 'openid email profile',
  };
  const client = await buildOidcClient(oidcCfg);
  const ceremonies = new DrizzleOidcCeremoniesRepository(t.sql);
  // Need the Drizzle Db handle for orgSettings — the helper exposes deps but
  // not db. Reach through deps.spaces which has the Db (private, but tests
  // know best). Cleaner: ask helpers for it. We patch by importing createDb
  // directly using the same TEST_URL.
  const { createDb } = await import('@diluxite/db');
  const conn = createDb(
    process.env.TEST_DATABASE_URL ??
      'postgres://diluxite:diluxite@localhost:5432/diluxite_test',
  );
  const orgSettings = new DrizzleOrgSettingsRepository(conn.db);
  const authDeps: NonNullable<AppDeps['oidc']> = {
    config: oidcCfg,
    client,
    ceremonies,
    orgSettings,
    orgId: t.defaultOrgId,
  };

  // Default: server mode (so the /api/auth/login guard passes for OIDC
  // path too, even though we don't exercise password login here).
  const deps: AppDeps = { ...t.deps, oidc: authDeps, info: { ...t.deps.info!, authMode: 'server' } };
  await t.app.close();
  const app = await buildApp(deps);
  await app.ready();

  return {
    app,
    deps,
    issuer,
    oidcCfg,
    authDeps,
    sql: t.sql,
  } as unknown as E2EHandles;
}

/** Walk through the full redirect flow, returning the cookie-setting response. */
async function performOidcLogin(app: FastifyInstance, issuer: MockIssuer): Promise<{
  loginRes: Awaited<ReturnType<FastifyInstance['inject']>>;
  authorizeRes: Response;
  callbackRes: Awaited<ReturnType<FastifyInstance['inject']>>;
}> {
  // Step 1: GET /api/auth/oidc/login → 302 al mock issuer.
  const loginRes = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  if (loginRes.statusCode !== 302) {
    throw new Error(
      `expected 302 from /api/auth/oidc/login, got ${loginRes.statusCode}: ${loginRes.body}`,
    );
  }
  const authorizeUrl = loginRes.headers['location'] as string;
  if (!authorizeUrl) throw new Error('login response has no Location header');

  // Step 2: visit the mock issuer /authorize with the same params.
  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authorizeRes.headers.get('location');
  if (!callbackUrl) {
    throw new Error(
      `mock issuer didn't redirect; status=${authorizeRes.status} body=${await authorizeRes.text()}`,
    );
  }

  // Step 3: replay the callback against Diluxite.
  const cbPath = callbackUrl.replace('http://localhost:3030', '');
  const callbackRes = await app.inject({ method: 'GET', url: cbPath });

  void issuer;
  return { loginRes, authorizeRes, callbackRes };
}

describe('OIDC E2E — happy paths', () => {
  let h: E2EHandles;

  beforeEach(async () => {
    h = await bootE2E();
  });

  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('JIT creates a brand-new user from claims and sets a session cookie', async () => {
    h.issuer.config.claims = {
      email: 'ana@empresa.com',
      email_verified: true,
      given_name: 'Ana',
      family_name: 'Pérez',
    };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers['location']).toBe('/');
    // Set-Cookie con session token HttpOnly.
    const setCookie = callbackRes.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toMatch(/diluxite_session=/);
    expect(cookieStr).toMatch(/HttpOnly/);
    expect(cookieStr).toMatch(/SameSite=Lax/);

    // El user existe en la DB con provider='oidc' y nombres.
    const user = await h.deps.users.findByEmail('ana@empresa.com');
    expect(user).toBeTruthy();
    expect(user!.provider).toBe('oidc');
    expect(user!.firstName).toBe('Ana');
    expect(user!.lastName).toBe('Pérez');
  });

  it('Existing user does NOT re-create — second login keeps same id', async () => {
    h.issuer.config.claims = { email: 'ana@empresa.com', email_verified: true, given_name: 'Ana', family_name: 'Pérez' };
    await performOidcLogin(h.app, h.issuer);
    const u1 = await h.deps.users.findByEmail('ana@empresa.com');

    await performOidcLogin(h.app, h.issuer);
    const u2 = await h.deps.users.findByEmail('ana@empresa.com');
    expect(u2!.id).toBe(u1!.id);
    // Provider stays the original (not overwritten on each login).
    expect(u2!.provider).toBe('oidc');
  });

  it('Updates last_login_at on every successful callback', async () => {
    h.issuer.config.claims = { email: 'ana@empresa.com', email_verified: true };
    await performOidcLogin(h.app, h.issuer);
    const before = (await h.deps.users.findByEmail('ana@empresa.com'))!.lastLoginAt;
    // Wait a beat so the timestamp can move.
    await new Promise((r) => setTimeout(r, 30));
    await performOidcLogin(h.app, h.issuer);
    const after = (await h.deps.users.findByEmail('ana@empresa.com'))!.lastLoginAt;
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
  });

  it('Lowercases the email claim before matching', async () => {
    h.issuer.config.claims = { email: 'Mixed.Case@EMPRESA.com', email_verified: true };
    await performOidcLogin(h.app, h.issuer);
    expect(await h.deps.users.findByEmail('mixed.case@empresa.com')).toBeTruthy();
    expect(await h.deps.users.findByEmail('Mixed.Case@EMPRESA.com')).toBeTruthy(); // findByEmail lower-cases internally
  });
});

describe('OIDC E2E — auth_policy enforcement', () => {
  let h: E2EHandles;

  beforeEach(async () => {
    h = await bootE2E();
  });

  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('deny_unknown → unknown email → 403', async () => {
    await h.authDeps.orgSettings.setAuthPolicy(h.authDeps.orgId, 'deny_unknown');
    h.issuer.config.claims = { email: 'unknown@x.com' };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/deny_unknown/i);
    // Y NO se creó el user.
    expect(await h.deps.users.findByEmail('unknown@x.com')).toBeNull();
  });

  it('pre_provisioned_only → unknown email → 403 con mensaje friendly', async () => {
    await h.authDeps.orgSettings.setAuthPolicy(h.authDeps.orgId, 'pre_provisioned_only');
    h.issuer.config.claims = { email: 'unknown@x.com' };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/admin to import|not provisioned/i);
    expect(await h.deps.users.findByEmail('unknown@x.com')).toBeNull();
  });

  it('pre_provisioned_only → user PRE-CARGADO vía CSV → entra OK', async () => {
    await h.authDeps.orgSettings.setAuthPolicy(h.authDeps.orgId, 'pre_provisioned_only');
    // Admin pre-loaded this user via CSV (simulating the import flow).
    await h.deps.users.upsertFromCsv({
      email: 'pre@x.com',
      firstName: 'Pre',
      lastName: 'Loaded',
    });
    h.issuer.config.claims = { email: 'pre@x.com', email_verified: true };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers['location']).toBe('/');
    // The CSV-loaded user keeps its existing provider tag.
    expect((await h.deps.users.findByEmail('pre@x.com'))!.provider).toBe('csv_import');
  });

  it('allow_unknown_as_member (default) → unknown email → JIT, status 302', async () => {
    // Default already; just verify.
    h.issuer.config.claims = { email: 'new@x.com', email_verified: true };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(302);
    expect(await h.deps.users.findByEmail('new@x.com')).toBeTruthy();
  });
});

describe('OIDC E2E — soft-disable enforcement', () => {
  let h: E2EHandles;
  beforeEach(async () => { h = await bootE2E(); });
  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('active=false → IdP authenticates fine, but Diluxite refuses with 403', async () => {
    h.issuer.config.claims = { email: 'disabled@x.com', email_verified: true };
    // First login: succeed and create the user.
    await performOidcLogin(h.app, h.issuer);
    const u = await h.deps.users.findByEmail('disabled@x.com');
    expect(u).toBeTruthy();
    // Admin disables.
    await h.deps.users.setActive(u!.id, false);

    // Second login attempt: IdP still authenticates but we 403.
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/disabled/i);
  });
});

describe('OIDC E2E — email_verified + account-takeover guards', () => {
  let h: E2EHandles;
  beforeEach(async () => { h = await bootE2E(); });
  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('JIT is refused when the IdP does NOT verify the email → 403, no user created', async () => {
    // allow_unknown_as_member is the default policy; the only thing stopping a
    // new user is the missing email_verified=true.
    h.issuer.config.claims = { email: 'unverified@x.com', email_verified: false };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/did not verify/i);
    expect(await h.deps.users.findByEmail('unverified@x.com')).toBeNull();
  });

  it('JIT is refused when the IdP omits email_verified entirely → 403', async () => {
    h.issuer.config.claims = { email: 'noflag@x.com' }; // no email_verified
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/did not verify/i);
    expect(await h.deps.users.findByEmail('noflag@x.com')).toBeNull();
  });

  it('OIDC login over an existing LOCAL password account is refused (no takeover) → 403', async () => {
    // Seed a local account WITH a password — exactly the credential SSO must
    // not be allowed to bypass.
    const { hashPassword } = await import('@diluxite/core');
    await h.sql`
      INSERT INTO users (email, provider, password_hash, active)
      VALUES ('victim@x.com', 'local', ${hashPassword('s3cret-pw')}, true)`;
    h.issuer.config.claims = { email: 'victim@x.com', email_verified: true };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(403);
    expect(callbackRes.json().error).toMatch(/different sign-in method/i);
    // No session cookie minted.
    const setCookie = callbackRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(cookieStr).not.toMatch(/diluxite_session=[^;]/);
    // Provider untouched.
    expect((await h.deps.users.findByEmail('victim@x.com'))!.provider).toBe('local');
  });

  it('Existing OIDC user with verified email → 200 (happy path intact)', async () => {
    h.issuer.config.claims = { email: 'sso@x.com', email_verified: true };
    const first = await performOidcLogin(h.app, h.issuer);
    expect(first.callbackRes.statusCode).toBe(302);
    expect((await h.deps.users.findByEmail('sso@x.com'))!.provider).toBe('oidc');
    // Second login over the now-existing provider='oidc' user still works.
    const second = await performOidcLogin(h.app, h.issuer);
    expect(second.callbackRes.statusCode).toBe(302);
  });
});

describe('OIDC E2E — token / ceremony adversarial', () => {
  let h: E2EHandles;
  beforeEach(async () => { h = await bootE2E(); });
  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('Callback with unknown state → 400 (replay / forgery prevention)', async () => {
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?state=neverIssued&code=fake',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/unknown or expired/);
  });

  it('Callback without state param → 400', async () => {
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=fake',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/missing state/);
  });

  it('Callback when IdP returned error=access_denied → 400', async () => {
    h.issuer.config.authorizeError = 'access_denied';
    // Step 1: trigger /authorize.
    const loginRes = await h.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const authorizeUrl = loginRes.headers['location'] as string;
    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = authorizeRes.headers.get('location')!;
    const cbPath = callbackUrl.replace('http://localhost:3030', '');
    const callbackRes = await h.app.inject({ method: 'GET', url: cbPath });
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/access_denied/);
  });

  it('id_token con iss forjado (no matchea discovery) → 400', async () => {
    // Si un atacante emite un JWT firmado con una key compartida pero con
    // un iss claim que no matchea el issuer del discovery, openid-client
    // tiene que rechazarlo. Es un test directo de validación de claims.
    h.issuer.config.forgedIssuer = 'https://attacker.example.com';
    h.issuer.config.claims = { email: 'mallory@x.com' };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/OIDC validation failed/);
    expect(await h.deps.users.findByEmail('mallory@x.com')).toBeNull();
  });

  // The error body is intentionally GENERIC ("OIDC validation failed") — we
  // don't reflect the raw validation message to the client (it could disclose
  // IdP internals). The detail lives in the server log. So these assert on the
  // 400 + generic message, not the specific reason.
  it('id_token sin email claim → 400', async () => {
    h.issuer.config.claims = { given_name: 'NoEmail' }; // email faltante
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/OIDC validation failed/);
  });

  it('id_token con email no-string → 400', async () => {
    h.issuer.config.claims = { email: 12345 as unknown as string };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/OIDC validation failed/);
  });

  it('id_token con email sin @ → 400', async () => {
    h.issuer.config.claims = { email: 'not-an-email' };
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/OIDC validation failed/);
  });

  it('Token endpoint devuelve invalid_grant → 400', async () => {
    h.issuer.config.tokenError = 'invalid_grant';
    const { callbackRes } = await performOidcLogin(h.app, h.issuer);
    expect(callbackRes.statusCode).toBe(400);
    expect(callbackRes.json().error).toMatch(/validation failed/);
  });
});

describe('OIDC E2E — ceremony single-use', () => {
  let h: E2EHandles;
  beforeEach(async () => { h = await bootE2E(); });
  afterEach(async () => {
    await h.app.close();
    await h.issuer.destroy();
    await h.sql.end();
  });

  it('Replaying the same callback URL → first 302, second 400', async () => {
    // We can't trivially reuse the helper because we want to fire the same
    // callback URL twice. Hit /authorize manually, capture the callback URL,
    // and hit it through Diluxite twice.
    h.issuer.config.claims = { email: 'replay@x.com', email_verified: true };
    const loginRes = await h.app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const authorizeUrl = loginRes.headers['location'] as string;
    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    const cbPath = (authorizeRes.headers.get('location') as string).replace(
      'http://localhost:3030',
      '',
    );

    const first = await h.app.inject({ method: 'GET', url: cbPath });
    expect(first.statusCode).toBe(302);

    const second = await h.app.inject({ method: 'GET', url: cbPath });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/unknown or expired/);
  });
});
