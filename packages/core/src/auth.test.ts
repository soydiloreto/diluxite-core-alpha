import { describe, it, expect } from 'vitest';
import {
  bearerToken,
  identityUserId,
  SessionAuthProvider,
  SingleUserAuthProvider,
  StoredTokenAuthProvider,
  TokenAuthProvider,
  type ResolvedTokenIdentity,
  type SessionStore,
  type TokenStore,
} from './auth';

describe('bearerToken', () => {
  it('acepta el scheme case-insensitive (RFC 6750)', () => {
    expect(bearerToken({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'BEARER abc' })).toBe('abc');
  });

  it('rechaza headers sin scheme o vacíos', () => {
    expect(bearerToken({})).toBeUndefined();
    expect(bearerToken({ authorization: 'abc' })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer ' })).toBeUndefined();
  });
});

describe('SingleUserAuthProvider', () => {
  it('devuelve siempre el mismo usuario, ignorando headers', async () => {
    const p = new SingleUserAuthProvider('u1');
    expect(await p.resolve({})).toEqual({ kind: 'user', userId: 'u1' });
    expect(await p.resolve({ authorization: 'Bearer cualquiera' })).toEqual({ kind: 'user', userId: 'u1' });
  });
});

describe('TokenAuthProvider', () => {
  const p = new TokenAuthProvider(new Map([['tokA', 'userA'], ['tokB', 'userB']]));

  it('resuelve un token válido', async () => {
    expect(await p.resolve({ authorization: 'Bearer tokA' })).toEqual({ kind: 'user', userId: 'userA' });
    expect(await p.resolve({ authorization: 'Bearer tokB' })).toEqual({ kind: 'user', userId: 'userB' });
  });

  it('rechaza token desconocido, ausente o sin Bearer', async () => {
    expect(await p.resolve({ authorization: 'Bearer nope' })).toBeNull();
    expect(await p.resolve({})).toBeNull();
    expect(await p.resolve({ authorization: 'tokA' })).toBeNull();
  });

  it('soporta header como array', async () => {
    expect(await p.resolve({ authorization: ['Bearer tokA'] })).toEqual({ kind: 'user', userId: 'userA' });
  });
});

describe('StoredTokenAuthProvider', () => {
  const store: TokenStore = {
    findUserIdByToken: async (t) => (t === 'valido' ? 'user1' : null),
  };
  const p = new StoredTokenAuthProvider(store);

  it('resuelve contra el store', async () => {
    expect(await p.resolve({ authorization: 'Bearer valido' })).toEqual({ kind: 'user', userId: 'user1' });
  });

  it('rechaza token desconocido o ausente', async () => {
    expect(await p.resolve({ authorization: 'Bearer otro' })).toBeNull();
    expect(await p.resolve({})).toBeNull();
  });
});

describe('identityUserId', () => {
  it('devuelve el userId para una identidad de usuario', () => {
    expect(identityUserId({ kind: 'user', userId: 'u1' })).toBe('u1');
  });
  it('devuelve null para un org token', () => {
    expect(
      identityUserId({ kind: 'org', orgId: 'o1', tokenId: 't1', scopes: ['read'] }),
    ).toBeNull();
  });
});

/**
 * SessionAuthProvider con la resolución completa de tokens: separa user tokens
 * de ORG tokens. Es el núcleo de la feature de org tokens (Action/cron → MCP).
 */
describe('SessionAuthProvider — resolución user vs org token', () => {
  const sessions: SessionStore = {
    findUserIdBySession: async (t) => (t === 'sess-ok' ? 'u-session' : null),
    createSession: async () => ({ token: 'x', expiresAt: new Date() }),
    deleteSession: async () => {},
  };

  function tokenStore(map: Record<string, ResolvedTokenIdentity>): TokenStore {
    return {
      // Legacy path must NOT be used when resolveToken exists; throw to prove it.
      findUserIdByToken: async () => {
        throw new Error('findUserIdByToken should not be called when resolveToken exists');
      },
      resolveToken: async (t) => map[t] ?? null,
    };
  }

  it('cookie de sesión → identidad de usuario', async () => {
    const p = new SessionAuthProvider(sessions, tokenStore({}));
    expect(await p.resolve({ cookie: 'diluxite_session=sess-ok' })).toEqual({
      kind: 'user',
      userId: 'u-session',
    });
  });

  it('bearer de un user token (userId set) → identidad de usuario', async () => {
    const store = tokenStore({
      utok: { tokenId: 'tid-u', userId: 'u-bearer', orgId: null, scopes: [] },
    });
    const p = new SessionAuthProvider(sessions, store);
    expect(await p.resolve({ authorization: 'Bearer utok' })).toEqual({
      kind: 'user',
      userId: 'u-bearer',
    });
  });

  it('bearer de un ORG token (orgId set, user_id null) → identidad de org con scopes y tokenId', async () => {
    const store = tokenStore({
      otok: { tokenId: 'tid-o', userId: null, orgId: 'org-9', scopes: ['read', 'write'] },
    });
    const p = new SessionAuthProvider(sessions, store);
    expect(await p.resolve({ authorization: 'Bearer otok' })).toEqual({
      kind: 'org',
      orgId: 'org-9',
      tokenId: 'tid-o',
      scopes: ['read', 'write'],
    });
  });

  it('token desconocido → null', async () => {
    const p = new SessionAuthProvider(sessions, tokenStore({}));
    expect(await p.resolve({ authorization: 'Bearer nope' })).toBeNull();
  });

  it('fallback a findUserIdByToken cuando el store no implementa resolveToken', async () => {
    const legacyStore: TokenStore = {
      findUserIdByToken: async (t) => (t === 'leg' ? 'u-legacy' : null),
    };
    const p = new SessionAuthProvider(sessions, legacyStore);
    expect(await p.resolve({ authorization: 'Bearer leg' })).toEqual({
      kind: 'user',
      userId: 'u-legacy',
    });
  });
});
