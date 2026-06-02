import { describe, it, expect, vi } from 'vitest';
import {
  TrustedHeaderAuthProvider,
  type AuthPolicy,
  type UsersRepoForTrustedHeader,
} from './auth';

/**
 * Unit tests furiosos del TrustedHeaderAuthProvider (Fase 1.4).
 *
 * Cubrimos las 6 ramas posibles del decision tree + edges:
 *   1. Header faltante → null
 *   2. Header con email malformado → null
 *   3. Header con email VÁLIDO + user existe + active → JIT touchLastLogin, identity
 *   4. Header + user existe + active=false → null (gate cierra el API)
 *   5. Header + user NO existe + policy `deny_unknown` → null
 *   6. Header + user NO existe + policy `pre_provisioned_only` → null
 *   7. Header + user NO existe + policy `allow_unknown_as_member` → JIT create + touchLastLogin
 *   8. Email normalization (case + trim)
 *   9. Multi-valor (array) toma el primero
 *  10. Header name es case-insensitive (req.headers vienen lower-case en Fastify)
 */

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

function makeProvider(
  repo: UsersRepoForTrustedHeader,
  policy: AuthPolicy = 'allow_unknown_as_member',
  headerName = 'cf-access-authenticated-user-email',
) {
  return new TrustedHeaderAuthProvider(repo, {
    headerName,
    getAuthPolicy: async () => policy,
  });
}

describe('TrustedHeaderAuthProvider — header presence', () => {
  it('returns null when the header is missing entirely', async () => {
    const { repo, touch, create } = makeRepo();
    const p = makeProvider(repo);
    expect(await p.resolve({})).toBeNull();
    expect(touch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null when the header is empty string', async () => {
    const { repo } = makeRepo();
    const p = makeProvider(repo);
    expect(await p.resolve({ 'cf-access-authenticated-user-email': '' })).toBeNull();
  });

  it('returns null when the header is an array of empty', async () => {
    const { repo } = makeRepo();
    const p = makeProvider(repo);
    expect(await p.resolve({ 'cf-access-authenticated-user-email': [''] })).toBeNull();
  });
});

describe('TrustedHeaderAuthProvider — email shape', () => {
  it('returns null when the header value is not a valid email', async () => {
    const { repo, create } = makeRepo();
    const p = makeProvider(repo);
    expect(
      await p.resolve({ 'cf-access-authenticated-user-email': 'not-an-email' }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('lowercases + trims the email before matching', async () => {
    const { repo } = makeRepo([{ id: 'u1', email: 'ana@x.com', active: true }]);
    const p = makeProvider(repo);
    const id = await p.resolve({
      'cf-access-authenticated-user-email': '  Ana@X.COM ',
    });
    expect(id?.userId).toBe('u1');
  });

  it('multi-value header (array) → takes the first', async () => {
    const { repo } = makeRepo([{ id: 'u1', email: 'ana@x.com', active: true }]);
    const p = makeProvider(repo);
    const id = await p.resolve({
      'cf-access-authenticated-user-email': ['ana@x.com', 'other@x.com'],
    });
    expect(id?.userId).toBe('u1');
  });
});

describe('TrustedHeaderAuthProvider — existing user', () => {
  it('existing active user → identity + touchLastLogin', async () => {
    const { repo, touch, create } = makeRepo([
      { id: 'u-1', email: 'ana@x.com', active: true },
    ]);
    const p = makeProvider(repo);
    const id = await p.resolve({ 'cf-access-authenticated-user-email': 'ana@x.com' });
    expect(id?.userId).toBe('u-1');
    expect(touch).toHaveBeenCalledWith('u-1');
    expect(create).not.toHaveBeenCalled();
  });

  it('existing soft-disabled user (active=false) → null, NO touchLastLogin', async () => {
    const { repo, touch } = makeRepo([
      { id: 'u-disabled', email: 'banned@x.com', active: false },
    ]);
    const p = makeProvider(repo);
    expect(
      await p.resolve({ 'cf-access-authenticated-user-email': 'banned@x.com' }),
    ).toBeNull();
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('TrustedHeaderAuthProvider — JIT under policy', () => {
  it('policy=allow_unknown_as_member → unknown email JIT-creates + touchLastLogin', async () => {
    const { repo, touch, create } = makeRepo();
    const p = makeProvider(repo, 'allow_unknown_as_member');
    const id = await p.resolve({
      'cf-access-authenticated-user-email': 'new@x.com',
    });
    expect(id?.userId).toBe('new-1');
    expect(create).toHaveBeenCalledWith({
      email: 'new@x.com',
      provider: 'trusted_header',
    });
    expect(touch).toHaveBeenCalledWith('new-1');
  });

  it('policy=deny_unknown → unknown email → null, NO create', async () => {
    const { repo, touch, create } = makeRepo();
    const p = makeProvider(repo, 'deny_unknown');
    expect(
      await p.resolve({ 'cf-access-authenticated-user-email': 'new@x.com' }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it('policy=pre_provisioned_only → unknown email → null, NO create', async () => {
    const { repo, create } = makeRepo();
    const p = makeProvider(repo, 'pre_provisioned_only');
    expect(
      await p.resolve({ 'cf-access-authenticated-user-email': 'new@x.com' }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('policy=pre_provisioned_only + email pre-cargado via CSV → entra OK', async () => {
    const { repo, create } = makeRepo([
      { id: 'u-pre', email: 'pre@x.com', active: true },
    ]);
    const p = makeProvider(repo, 'pre_provisioned_only');
    const id = await p.resolve({
      'cf-access-authenticated-user-email': 'pre@x.com',
    });
    expect(id?.userId).toBe('u-pre');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('TrustedHeaderAuthProvider — config', () => {
  it('respects a custom header name', async () => {
    const { repo } = makeRepo([{ id: 'u1', email: 'ana@x.com', active: true }]);
    const p = makeProvider(repo, 'allow_unknown_as_member', 'x-forwarded-user');
    const id = await p.resolve({ 'x-forwarded-user': 'ana@x.com' });
    expect(id?.userId).toBe('u1');
  });

  it('does NOT honour the default Cloudflare header when configured for a different one', async () => {
    const { repo, create } = makeRepo([{ id: 'u1', email: 'ana@x.com', active: true }]);
    const p = makeProvider(repo, 'allow_unknown_as_member', 'x-authelia-email');
    // Sending the wrong header → no match (defends against operator
    // misconfig where multiple proxies set different headers).
    expect(
      await p.resolve({ 'cf-access-authenticated-user-email': 'ana@x.com' }),
    ).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
