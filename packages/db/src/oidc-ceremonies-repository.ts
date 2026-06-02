import postgres from 'postgres';

/**
 * Ephemeral state for in-flight OIDC ceremonies. Each row corresponds to a
 * single "user clicked Sign-in with SSO" → "IdP redirected back" exchange.
 *
 * We deliberately use a raw `postgres-js` connection rather than the Drizzle
 * `Db` because this table doesn't need any ORM features (no joins, no
 * complex queries, just 3 ops: insert, lookup-and-delete, sweep). Keeping
 * it out of `schema.ts` also avoids leaking transient infrastructure into
 * the Drizzle-typed surface — the rest of the codebase shouldn't accidentally
 * `db.select().from(oidcCeremonies)` it.
 */
export interface OidcCeremony {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes — generous for slow IdP / 2FA prompts

export class DrizzleOidcCeremoniesRepository {
  constructor(private readonly sql: postgres.Sql) {}

  /** Persist a brand-new ceremony with a 10-minute TTL. */
  async save(state: string, nonce: string, codeVerifier: string): Promise<void> {
    // postgres-js requires the timestamp as a string for the parameter
    // binding; passing a Date instance throws "must be of type string or
    // ArrayBuffer". ISO 8601 round-trips cleanly through `timestamp`.
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    await this.sql`
      INSERT INTO oidc_ceremonies (state, nonce, code_verifier, expires_at)
      VALUES (${state}, ${nonce}, ${codeVerifier}, ${expiresAt})
    `;
  }

  /**
   * Look up and immediately delete a ceremony (single use — replay safety).
   * Returns the row if it existed and was not expired, null otherwise.
   * The delete and the read are atomic via `DELETE … RETURNING …`.
   */
  async consume(state: string): Promise<OidcCeremony | null> {
    const rows = await this.sql<
      {
        state: string;
        nonce: string;
        code_verifier: string;
        expires_at: Date;
      }[]
    >`
      DELETE FROM oidc_ceremonies
      WHERE state = ${state} AND expires_at > NOW()
      RETURNING state, nonce, code_verifier, expires_at
    `;
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      state: r.state,
      nonce: r.nonce,
      codeVerifier: r.code_verifier,
      expiresAt: r.expires_at,
    };
  }

  /** Background sweep — admin call this if you don't want stale rows. */
  async sweepExpired(): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      WITH d AS (DELETE FROM oidc_ceremonies WHERE expires_at <= NOW() RETURNING 1)
      SELECT count(*)::text FROM d
    `;
    return Number(rows[0]?.count ?? 0);
  }
}
