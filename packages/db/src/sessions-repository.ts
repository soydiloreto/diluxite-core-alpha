import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, lt, ne } from 'drizzle-orm';
import type { SessionStore } from '@diluxite/core';
import type { Db } from './client';
import { sessions, users } from './schema';

export interface ActiveSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  /** True when this row matches the SHA-256(tokenHash) of the current request. */
  current: boolean;
}

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
    metadata?: { ip?: string | null; userAgent?: string | null },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.db.insert(sessions).values({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ip: metadata?.ip ?? null,
      userAgent: metadata?.userAgent ?? null,
      lastSeenAt: new Date(),
    });
    return { token, expiresAt };
  }

  async findUserIdBySession(token: string): Promise<string | null> {
    const now = new Date();
    // Join `users` so a soft-disabled account (active=false) stops resolving
    // immediately — every existing session of a user the admin just disabled
    // must lose its identity on the very next request, not at session expiry.
    const [row] = await this.db
      .select({ uid: sessions.userId, exp: sessions.expiresAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          gt(sessions.expiresAt, now),
          eq(users.active, true),
        ),
      );
    if (!row) return null;
    // Bump last_seen_at lazily on lookup — don't await (best-effort write).
    this.db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.tokenHash, hashSessionToken(token)))
      .catch(() => undefined);
    return row.uid;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
  }

  /**
   * List the user's active (non-expired) sessions. Used by the Settings →
   * Security UI so the user can spot a session they don't recognise and revoke it.
   * `currentToken` lets the UI mark "this is the one you're currently using".
   */
  async listActiveForUser(
    userId: string,
    currentToken: string | null,
  ): Promise<ActiveSession[]> {
    const now = new Date();
    const currentHash = currentToken ? hashSessionToken(currentToken) : null;
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastSeenAt), desc(sessions.createdAt));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      ip: r.ip,
      userAgent: r.userAgent,
      current: currentHash !== null && r.tokenHash === currentHash,
    }));
  }

  /**
   * Revoke a specific session by id. Returns the row count so the API can
   * answer 404 if the id isn't for this user. We require `userId` to
   * prevent cross-user revocation (defence in depth on top of the route guard).
   */
  async revokeForUser(userId: string, sessionId: string): Promise<boolean> {
    const rows = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /**
   * Revoke every session of the user except optionally the "current" one.
   * Useful for "log me out of all other devices" after detecting a leak.
   */
  async revokeAllForUser(
    userId: string,
    exceptToken?: string | null,
  ): Promise<number> {
    const exceptHash = exceptToken ? hashSessionToken(exceptToken) : null;
    const where = exceptHash
      ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, exceptHash))
      : eq(sessions.userId, userId);
    const rows = await this.db.delete(sessions).where(where).returning({ id: sessions.id });
    return rows.length;
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
