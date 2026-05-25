import { describe, it, expect } from 'vitest';
import { SingleUserAuthProvider, TokenAuthProvider } from './auth';

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
