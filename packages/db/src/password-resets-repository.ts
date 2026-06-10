import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { passwordResets } from './schema';

/**
 * Repository for the forgot-password reset flow.
 *
 * The plain `token` only exists in transit (email body); we persist its
 * SHA-256 hash. The hot path is `consumeActiveByHash(hash)` during reset.
 */

export interface PasswordResetRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  requestedIp: string | null;
  createdAt: Date;
}

export class DrizzlePasswordResetsRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedIp?: string | null;
  }): Promise<PasswordResetRow> {
    const [row] = await this.db
      .insert(passwordResets)
      .values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        requestedIp: input.requestedIp ?? null,
      })
      .returning();
    return row as PasswordResetRow;
  }

  /** Returns the row only if it exists, is not expired, and is not consumed. */
  async findActiveByHash(tokenHash: string, now: Date = new Date()): Promise<PasswordResetRow | null> {
    // Cast Date to ISO+timestamptz so the postgres-js driver doesn't have to
    // infer the parameter type — some driver versions reject Date directly
    // bound through prepared statements (ERR_INVALID_ARG_TYPE). Same shape
    // used in audit-events-repository.ts.
    const iso = now.toISOString();
    const [row] = await this.db
      .select()
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.consumedAt),
          sql`${passwordResets.expiresAt} > ${iso}::timestamptz`,
        ),
      );
    return (row as PasswordResetRow | undefined) ?? null;
  }

  /**
   * Atomically consume the token: one UPDATE that both checks "active"
   * (not expired, not consumed) and stamps consumed_at. Closes the TOCTOU
   * window of findActiveByHash + markConsumed — two concurrent resets with
   * the same token can never both get a row back.
   */
  async consumeActiveByHash(tokenHash: string, now: Date = new Date()): Promise<PasswordResetRow | null> {
    const iso = now.toISOString();
    const [row] = await this.db
      .update(passwordResets)
      .set({ consumedAt: sql`${iso}::timestamptz` })
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.consumedAt),
          sql`${passwordResets.expiresAt} > ${iso}::timestamptz`,
        ),
      )
      .returning();
    return (row as PasswordResetRow | undefined) ?? null;
  }

  async markConsumed(id: string, now: Date = new Date()): Promise<void> {
    const iso = now.toISOString();
    await this.db
      .update(passwordResets)
      .set({ consumedAt: sql`${iso}::timestamptz` })
      // Never overwrite an existing consumed_at — first consumption wins.
      .where(and(eq(passwordResets.id, id), isNull(passwordResets.consumedAt)));
  }

  /** Operational cleanup — caller can run this from a periodic job. */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const iso = now.toISOString();
    const r = await this.db
      .delete(passwordResets)
      .where(sql`${passwordResets.expiresAt} <= ${iso}::timestamptz`);
    return (r as unknown as { count?: number }).count ?? 0;
  }
}
