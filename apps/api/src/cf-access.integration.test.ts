import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { DrizzleOrgSettingsRepository, createDb } from '@diluxite/db';
import { buildApp } from './app';
import { buildTestApp } from '../test/helpers';
import { CfAccessJwtAuthProvider, cfAccessIssuer } from './cf-access';

/**
 * Integration del Cloudflare-Access-JWT path contra DB real + Fastify.
 *
 * Lo que cubre que el unit test NO puede: que el userId resuelto desde un JWT
 * verificado llegue de verdad a la query de `/api/spaces`, y que los caminos
 * negativos (sin header, firma forjada, aud equivocado) den 401 en el gate.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';
const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-integration-xyz';
const HEADER = 'cf-access-jwt-assertion';

interface Handles {
  app: FastifyInstance;
  sql: Sql;
  orgId: string;
  orgSettings: DrizzleOrgSettingsRepository;
  signValid: (email: string) => Promise<string>;
  signForged: (email: string) => Promise<string>;
  signWrongAud: (email: string) => Promise<string>;
}

async function boot(): Promise<Handles> {
  const real = await generateKeyPair('RS256', { extractable: true });
  const attacker = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(real.publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [jwk] });

  const mkSigner =
    (key: CryptoKey, aud: string) =>
    (email: string): Promise<string> =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(cfAccessIssuer(TEAM))
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('2h')
        .sign(key);

  const t = await buildTestApp();
  const db = createDb(TEST_URL).db;
  const orgSettings = new DrizzleOrgSettingsRepository(db);
  const cfAuth = new CfAccessJwtAuthProvider(
    t.deps.users,
    { teamDomain: TEAM, aud: AUD },
    () => orgSettings.getAuthPolicy(t.defaultOrgId),
    jwks,
  );
  await t.app.close();
  const app = await buildApp({ ...t.deps, auth: cfAuth });
  await app.ready();
  return {
    app,
    sql: t.sql,
    orgId: t.defaultOrgId,
    orgSettings,
    signValid: mkSigner(real.privateKey, AUD),
    signForged: mkSigner(attacker.privateKey, AUD),
    signWrongAud: mkSigner(real.privateKey, 'some-other-app'),
  };
}

describe('Cloudflare Access JWT — integration', () => {
  let h: Handles;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.app.close();
    await h.sql.end();
  });

  it('valid JWT + default policy → JIT-creates user and returns spaces', async () => {
    const token = await h.signValid('ana@x.com');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: token },
    });
    expect(r.statusCode).toBe(200);
  });

  it('no header → 401', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/spaces' });
    expect(r.statusCode).toBe(401);
  });

  it('forged signature (attacker key) → 401', async () => {
    const token = await h.signForged('admin@x.com');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: token },
    });
    expect(r.statusCode).toBe(401);
  });

  it('valid signature but wrong AUD (token for another Access app) → 401', async () => {
    const token = await h.signWrongAud('ana@x.com');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: token },
    });
    expect(r.statusCode).toBe(401);
  });

  it('policy deny_unknown + unknown email → 401', async () => {
    await h.orgSettings.setAuthPolicy(h.orgId, 'deny_unknown');
    const token = await h.signValid('stranger@x.com');
    const r = await h.app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { [HEADER]: token },
    });
    expect(r.statusCode).toBe(401);
  });
});
