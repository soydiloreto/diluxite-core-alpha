import { and, eq, gt, lt } from 'drizzle-orm';
import type { Db } from './client';
import { passkeys, webauthnChallenges } from './schema';

export interface PasskeyRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: string | null;
  label: string;
  transports: string[];
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * WebAuthn credential storage + transient challenge store.
 *
 *  - `passkeys` holds the long-lived registered credentials per user.
 *  - `webauthn_challenges` holds one row per in-flight ceremony. We issue a
 *    random challenge (with a TTL) and consume it on verify, both for
 *    registration and for authentication.
 */
export class DrizzlePasskeysRepository {
  constructor(private readonly db: Db) {}

  async listForUser(userId: string): Promise<PasskeyRow[]> {
    return this.db.select().from(passkeys).where(eq(passkeys.userId, userId)) as Promise<
      PasskeyRow[]
    >;
  }

  async findByCredentialId(credentialId: string): Promise<PasskeyRow | null> {
    const [row] = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId));
    return (row as PasskeyRow | undefined) ?? null;
  }

  async register(input: {
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    deviceType?: string | null;
    label?: string;
    transports?: string[];
    backedUp?: boolean;
  }): Promise<PasskeyRow> {
    const [row] = await this.db
      .insert(passkeys)
      .values({
        userId: input.userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: input.counter,
        deviceType: input.deviceType ?? null,
        label: input.label ?? 'passkey',
        transports: input.transports ?? [],
        backedUp: input.backedUp ?? false,
      })
      .returning();
    return row as PasskeyRow;
  }

  async updateCounter(credentialId: string, counter: number): Promise<void> {
    await this.db
      .update(passkeys)
      .set({ counter, lastUsedAt: new Date() })
      .where(eq(passkeys.credentialId, credentialId));
  }

  async rename(userId: string, id: string, label: string): Promise<boolean> {
    const rows = await this.db
      .update(passkeys)
      .set({ label })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning({ id: passkeys.id });
    return rows.length > 0;
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning({ id: passkeys.id });
    return rows.length > 0;
  }

  async saveChallenge(
    challenge: string,
    kind: 'registration' | 'authentication',
    userId: string | null = null,
    ttlSeconds = 300,
  ): Promise<void> {
    await this.db.insert(webauthnChallenges).values({
      challenge,
      kind,
      userId,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
  }

  /**
   * Atomically consume a challenge by token+kind. Returns `{ userId }` for
   * registration challenges (we know who started the flow); `{ userId: null }`
   * for authentication (we'll learn the user from the credentialId on verify).
   * Returns null if the challenge is missing, of the wrong kind, or expired.
   */
  async takeChallenge(
    challenge: string,
    kind: 'registration' | 'authentication',
  ): Promise<{ userId: string | null } | null> {
    const now = new Date();
    const rows = await this.db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.challenge, challenge),
          eq(webauthnChallenges.kind, kind),
          gt(webauthnChallenges.expiresAt, now),
        ),
      )
      .returning({ userId: webauthnChallenges.userId });
    return rows[0] ?? null;
  }

  async pruneExpiredChallenges(): Promise<number> {
    const rows = await this.db
      .delete(webauthnChallenges)
      .where(lt(webauthnChallenges.expiresAt, new Date()))
      .returning({ id: webauthnChallenges.id });
    return rows.length;
  }
}
