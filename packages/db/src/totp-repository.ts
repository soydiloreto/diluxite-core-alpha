import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { totpSecrets } from './schema';

/**
 * Repository for the totp_secrets table. The persistence is intentionally
 * minimal — verify happens in code (core/totp.ts) on the secret returned
 * from `getSecret`.
 */

export interface TotpRow {
  userId: string;
  secret: string;
  confirmedAt: Date;
  backupCodes: string[];
}

export class DrizzleTotpRepository {
  constructor(private readonly db: Db) {}

  async getForUser(userId: string): Promise<TotpRow | null> {
    const [row] = await this.db
      .select()
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId));
    if (!row) return null;
    return {
      userId: row.userId,
      secret: row.secret,
      confirmedAt: row.confirmedAt,
      backupCodes: row.backupCodes ?? [],
    };
  }

  /**
   * Enroll a user with a fresh secret + N hashed backup codes. Idempotent
   * over the (user_id) PK — re-enrolling REPLACES the previous secret. The
   * caller is expected to surface a "this overwrites your current 2FA" warning.
   */
  async enroll(input: {
    userId: string;
    secret: string;
    backupCodes: string[];
  }): Promise<void> {
    await this.db
      .insert(totpSecrets)
      .values({
        userId: input.userId,
        secret: input.secret,
        backupCodes: input.backupCodes,
      })
      .onConflictDoUpdate({
        target: totpSecrets.userId,
        set: {
          secret: input.secret,
          backupCodes: input.backupCodes,
          confirmedAt: new Date(),
        },
      });
  }

  /**
   * Consume a backup code. Returns true iff the hash existed in the row;
   * in that case it's removed atomically. Returns false if not found OR
   * if the user has no row at all.
   */
  async consumeBackupCode(userId: string, hashedCode: string): Promise<boolean> {
    // Single atomic UPDATE — the row-level lock makes "remove iff present"
    // race-free, so two concurrent attempts can never both consume the same
    // code (the old read-modify-write version allowed exactly that).
    const rows = await this.db
      .update(totpSecrets)
      .set({ backupCodes: sql`array_remove(${totpSecrets.backupCodes}, ${hashedCode})` })
      .where(
        and(
          eq(totpSecrets.userId, userId),
          sql`${hashedCode} = ANY(${totpSecrets.backupCodes})`,
        ),
      )
      .returning({ userId: totpSecrets.userId });
    return rows.length > 0;
  }

  async deleteForUser(userId: string): Promise<boolean> {
    // Use RETURNING + rows.length instead of the driver's count proxy: when
    // `count` is undefined the old `!== 0` check returned true even though
    // nothing was deleted. rows.length is unambiguous.
    const rows = await this.db
      .delete(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .returning({ userId: totpSecrets.userId });
    return rows.length > 0;
  }
}
