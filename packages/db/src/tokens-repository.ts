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
  name: string;
  createdAt: Date;
}

export class DrizzleTokensRepository implements TokenStore {
  constructor(private readonly db: Db) {}

  /** Creates a token: returns the CLEARTEXT value once + the metadata. */
  async create(userId: string, name = 'token'): Promise<{ token: string; info: TokenInfo }> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(tokens)
      .values({ userId, tokenHash: hashToken(token), name })
      .returning();
    return { token, info: { id: row.id, name: row.name, createdAt: row.createdAt } };
  }

  async findUserIdByToken(token: string): Promise<string | null> {
    const [row] = await this.db
      .select({ uid: tokens.userId })
      .from(tokens)
      .where(eq(tokens.tokenHash, hashToken(token)));
    return row?.uid ?? null;
  }

  async list(userId: string): Promise<TokenInfo[]> {
    return this.db
      .select({ id: tokens.id, name: tokens.name, createdAt: tokens.createdAt })
      .from(tokens)
      .where(eq(tokens.userId, userId));
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(tokens)
      .where(and(eq(tokens.id, id), eq(tokens.userId, userId)))
      .returning({ id: tokens.id });
    return rows.length > 0;
  }
}
