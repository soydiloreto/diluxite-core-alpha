import { describe, it, expect } from 'vitest';
import {
  SingleUserAuthProvider,
  StoredTokenAuthProvider,
  TokenAuthProvider,
  type TokenStore,
} from './auth';

describe('SingleUserAuthProvider', () => {
  it('devuelve siempre el mismo usuario, ignorando headers', async () => {
    const p = new SingleUserAuthProvider('u1');
    expect(await p.resolve({})).toEqual({ userId: 'u1' });
    expect(await p.resolve({ authorization: 'Bearer cualquiera' })).toEqual({ userId: 'u1' });
  });
});

describe('TokenAuthProvider', () => {
  const p = new TokenAuthProvider(new Map([['tokA', 'userA'], ['tokB', 'userB']]));

  it('resuelve un token válido', async () => {
    expect(await p.resolve({ authorization: 'Bearer tokA' })).toEqual({ userId: 'userA' });
    expect(await p.resolve({ authorization: 'Bearer tokB' })).toEqual({ userId: 'userB' });
  });

  it('rechaza token desconocido, ausente o sin Bearer', async () => {
    expect(await p.resolve({ authorization: 'Bearer nope' })).toBeNull();
    expect(await p.resolve({})).toBeNull();
    expect(await p.resolve({ authorization: 'tokA' })).toBeNull();
  });

  it('soporta header como array', async () => {
    expect(await p.resolve({ authorization: ['Bearer tokA'] })).toEqual({ userId: 'userA' });
  });
});

describe('StoredTokenAuthProvider', () => {
  const store: TokenStore = {
    findUserIdByToken: async (t) => (t === 'valido' ? 'user1' : null),
  };
  const p = new StoredTokenAuthProvider(store);

  it('resuelve contra el store', async () => {
    expect(await p.resolve({ authorization: 'Bearer valido' })).toEqual({ userId: 'user1' });
  });

  it('rechaza token desconocido o ausente', async () => {
    expect(await p.resolve({ authorization: 'Bearer otro' })).toBeNull();
    expect(await p.resolve({})).toBeNull();
  });
});
