import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { StoredTokenAuthProvider } from '@diluxite/core';
import { getTestDb, truncateAll } from '../test/helpers';
import { DrizzleTokensRepository } from './tokens-repository';
import { DrizzleUsersRepository } from './spaces-repository';

const { sql, db } = getTestDb();

afterAll(async () => {
  await sql.end();
});

describe('Tokens por usuario (integración)', () => {
  let tokensRepo: DrizzleTokensRepository;
  let userId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    const users = new DrizzleUsersRepository(db);
    userId = (await users.create('a@diluxite')).id;
    tokensRepo = new DrizzleTokensRepository(db);
  });

  it('crea un token y lo verifica por hash', async () => {
    const { token, info } = await tokensRepo.create(userId, 'claude');
    expect(token).toBeTruthy();
    expect(info.nombre).toBe('claude');
    expect(await tokensRepo.findUserIdByToken(token)).toBe(userId);
    expect(await tokensRepo.findUserIdByToken('invalido')).toBeNull();
  });

  it('StoredTokenAuthProvider resuelve el token recién creado', async () => {
    const { token } = await tokensRepo.create(userId);
    const provider = new StoredTokenAuthProvider(tokensRepo);
    expect(await provider.resolve({ authorization: `Bearer ${token}` })).toEqual({ userId });
  });

  it('lista y revoca tokens', async () => {
    const { token, info } = await tokensRepo.create(userId, 'a');
    await tokensRepo.create(userId, 'b');
    expect(await tokensRepo.list(userId)).toHaveLength(2);
    expect(await tokensRepo.revoke(userId, info.id)).toBe(true);
    expect(await tokensRepo.findUserIdByToken(token)).toBeNull();
    expect(await tokensRepo.list(userId)).toHaveLength(1);
  });

  it('no revoca tokens de otro usuario', async () => {
    const other = (await new DrizzleUsersRepository(db).create('b@diluxite')).id;
    const { info } = await tokensRepo.create(userId, 'mío');
    expect(await tokensRepo.revoke(other, info.id)).toBe(false);
  });
});
