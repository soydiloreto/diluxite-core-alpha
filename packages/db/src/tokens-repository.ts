import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { TokenStore } from '@diluxite/core';
import type { Db } from './client';
import { tokens } from './schema';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenInfo {
  id: string;
  nombre: string;
  creado: Date;
}

export class DrizzleTokensRepository implements TokenStore {
  constructor(private readonly db: Db) {}

  /** Crea un token: devuelve el valor EN CLARO una sola vez + la metadata. */
  async create(userId: string, nombre = 'token'): Promise<{ token: string; info: TokenInfo }> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(tokens)
      .values({ usuarioId: userId, tokenHash: hashToken(token), nombre })
      .returning();
    return { token, info: { id: row.id, nombre: row.nombre, creado: row.creado } };
  }

  async findUserIdByToken(token: string): Promise<string | null> {
    const [row] = await this.db
      .select({ uid: tokens.usuarioId })
      .from(tokens)
      .where(eq(tokens.tokenHash, hashToken(token)));
    return row?.uid ?? null;
  }

  async list(userId: string): Promise<TokenInfo[]> {
    return this.db
      .select({ id: tokens.id, nombre: tokens.nombre, creado: tokens.creado })
      .from(tokens)
      .where(eq(tokens.usuarioId, userId));
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(tokens)
      .where(and(eq(tokens.id, id), eq(tokens.usuarioId, userId)))
      .returning({ id: tokens.id });
    return rows.length > 0;
  }
}
