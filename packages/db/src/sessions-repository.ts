import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { SessionStore } from '@diluxite/core';
import type { Db } from './client';
import { sessions } from './schema';

/**
 * Server-mode session storage. The plaintext token never leaves the API
 * response that creates it (set as an HttpOnly cookie); the DB only holds
 * its SHA-256 hash + a TTL. Expired sessions are pruned lazily on lookup.
 */
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export class DrizzleSessionsRepository implements SessionStore {
  constructor(private readonly db: Db) {}

  async createSession(
    userId: string,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.db
      .insert(sessions)
      .values({ userId, tokenHash: hashSessionToken(token), expiresAt });
    return { token, expiresAt };
  }

  async findUserIdBySession(token: string): Promise<string | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ uid: sessions.userId, exp: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), gt(sessions.expiresAt, now)));
    return row?.uid ?? null;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  }

  /** Maintenance helper — remove all expired sessions. Call from a cron / on boot. */
  async pruneExpired(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
