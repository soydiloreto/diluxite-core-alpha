import { describe, it, expect, vi } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { identityUserId, type AuthPolicy, type UsersRepoForTrustedHeader } from '@diluxite/core';
import {
  CfAccessJwtAuthProvider,
  verifyCfAccessEmail,
  cfAccessIssuer,
  cfAccessJwksUrl,
} from './cf-access';

/**
 * Tests furiosos del CfAccessJwtAuthProvider.
 *
 * El punto central de seguridad: SOLO se confía en el email DESPUÉS de validar
 * la firma RS256 + issuer + aud + exp. Un request que llega directo al puerto
 * (sin pasar por Cloudflare) con un JWT inventado o de otra app NO entra.
 *
 *  1. JWT válido → email verificado.
 *  2. Firma con OTRA clave (spoof) → null.
 *  3. AUD equivocado (token de otra Access app del mismo team) → null.
 *  4. Issuer equivocado → null.
 *  5. Token expirado → null.
 *  6. Token sin claim `email` → null.
 *  7. Header ausente / vacío / array → null.
 *  8. Provider: usuario existente activo → identity (provider 'cf_access').
 *  9. Provider: desconocido + deny_unknown → null.
 * 10. Provider: desconocido + allow_unknown_as_member → JIT create.
 * 11. Provider: usuario active=false → null.
 */

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'aud-tag-abc123';
const HEADER = 'cf-access-jwt-assertion';
const CFG = { teamDomain: TEAM, aud: AUD };

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { privateKey, jwks };
}

async function signToken(
  privateKey: CryptoKey,
  opts: { email?: string | null; iss?: string; aud?: string; exp?: string | number } = {},
) {
  const payload: Record<string, unknown> = {};
  if (opts.email !== null) payload.email = opts.email ?? 'ana@x.com';
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? cfAccessIssuer(TEAM))
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '2h')
    .sign(privateKey);
}

function makeRepo(initial: Array<{ id: string; email: string; active?: boolean }> = []) {
  const users = new Map<string, { id: string; email: string; active?: boolean }>();
  for (const u of initial) users.set(u.email.toLowerCase(), u);
  const touch = vi.fn();
  const create = vi.fn(async (input: { email: string }) => {
    const u = { id: `new-${users.size + 1}`, email: input.email.toLowerCase(), active: true };
    users.set(u.email, u);
    return u;
  });
  const repo: UsersRepoForTrustedHeader = {
    async findByEmail(email) {
      return users.get(email.toLowerCase()) ?? null;
    },
    createFromExternal: create,
    touchLastLogin: touch,
  };
  return { repo, touch, create };
}

describe('cfAccessIssuer / cfAccessJwksUrl', () => {
  it('normalises team domain (strips protocol + trailing slash)', () => {
    expect(cfAccessIssuer('myteam.cloudflareaccess.com')).toBe(
      'https://myteam.cloudflareaccess.com',
    );
    expect(cfAccessIssuer('https://myteam.cloudflareaccess.com/')).toBe(
      'https://myteam.cloudflareaccess.com',
    );
    expect(cfAccessJwksUrl(TEAM).toString()).toBe(
      'https://myteam.cloudflareaccess.com/cdn-cgi/access/certs',
    );
  });
});

describe('verifyCfAccessEmail — signature & claims', () => {
  it('valid token → returns the verified email', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await signToken(privateKey, { email: 'ana@x.com' });
    expect(await verifyCfAccessEmail(token, CFG, jwks)).toBe('ana@x.com');
  });

  it('token signed with a DIFFERENT key (spoof) → null', async () => {
    const { jwks } = await makeKeys(); // trusted set
    const attacker = await makeKeys(); // attacker's key, not in jwks
    const forged = await signToken(attacker.privateKey, { email: 'ana@x.com' });
    expect(await verifyCfAccessEmail(forged, CFG, jwks)).toBeNull();
  });

  it('wrong audience (token for another Access app) → null', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await signToken(privateKey, { aud: 'some-other-app-aud' });
    expect(await verifyCfAccessEmail(token, CFG, jwks)).toBeNull();
  });

  it('wrong issuer → null', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await signToken(privateKey, { iss: 'https://evil.example.com' });
    expect(await verifyCfAccessEmail(token, CFG, jwks)).toBeNull();
  });

  it('expired token → null', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await signToken(privateKey, { exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyCfAccessEmail(token, CFG, jwks)).toBeNull();
  });

  it('valid signature but no email claim → null', async () => {
    const { privateKey, jwks } = await makeKeys();
    const token = await signToken(privateKey, { email: null });
    expect(await verifyCfAccessEmail(token, CFG, jwks)).toBeNull();
  });

  it('garbage token → null', async () => {
    const { jwks } = await makeKeys();
    expect(await verifyCfAccessEmail('not.a.jwt', CFG, jwks)).toBeNull();
  });
});

describe('CfAccessJwtAuthProvider — header handling', () => {
  it('missing / empty / array-empty header → null', async () => {
    const { jwks } = await makeKeys();
    const { repo } = makeRepo();
    const p = new CfAccessJwtAuthProvider(repo, CFG, async () => 'allow_unknown_as_member', jwks);
    expect(await p.resolve({})).toBeNull();
    expect(await p.resolve({ [HEADER]: '' })).toBeNull();
    expect(await p.resolve({ [HEADER]: [''] })).toBeNull();
  });

  it('forged token in the header → null (does NOT fall through to email trust)', async () => {
    const { jwks } = await makeKeys();
    const attacker = await makeKeys();
    const forged = await signToken(attacker.privateKey, { email: 'admin@x.com' });
    const { repo, touch } = makeRepo([{ id: 'u-admin', email: 'admin@x.com', active: true }]);
    const p = new CfAccessJwtAuthProvider(repo, CFG, async () => 'allow_unknown_as_member', jwks);
    expect(await p.resolve({ [HEADER]: forged })).toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('CfAccessJwtAuthProvider — identity resolution under policy', () => {
  async function providerWith(
    initial: Array<{ id: string; email: string; active?: boolean }>,
    policy: AuthPolicy,
  ) {
    const { privateKey, jwks } = await makeKeys();
    const { repo, touch, create } = makeRepo(initial);
    const p = new CfAccessJwtAuthProvider(repo, CFG, async () => policy, jwks);
    return { p, privateKey, touch, create };
  }

  it('existing active user → identity + touchLastLogin', async () => {
    const { p, privateKey, touch, create } = await providerWith(
      [{ id: 'u-1', email: 'ana@x.com', active: true }],
      'deny_unknown',
    );
    const token = await signToken(privateKey, { email: 'Ana@X.com' }); // case-insensitive
    const id = await p.resolve({ [HEADER]: token });
    expect(id && identityUserId(id)).toBe('u-1');
    expect(touch).toHaveBeenCalledWith('u-1');
    expect(create).not.toHaveBeenCalled();
  });

  it('existing disabled user (active=false) → null', async () => {
    const { p, privateKey, touch } = await providerWith(
      [{ id: 'u-x', email: 'banned@x.com', active: false }],
      'allow_unknown_as_member',
    );
    const token = await signToken(privateKey, { email: 'banned@x.com' });
    expect(await p.resolve({ [HEADER]: token })).toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });

  it('unknown email + allow_unknown_as_member → JIT create with provider cf_access', async () => {
    const { p, privateKey, create, touch } = await providerWith([], 'allow_unknown_as_member');
    const token = await signToken(privateKey, { email: 'new@x.com' });
    const id = await p.resolve({ [HEADER]: token });
    expect(id && identityUserId(id)).toBe('new-1');
    expect(create).toHaveBeenCalledWith({ email: 'new@x.com', provider: 'cf_access' });
    expect(touch).toHaveBeenCalledWith('new-1');
  });

  it('unknown email + deny_unknown → null, no create', async () => {
    const { p, privateKey, create } = await providerWith([], 'deny_unknown');
    const token = await signToken(privateKey, { email: 'new@x.com' });
    expect(await p.resolve({ [HEADER]: token })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
