import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
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
  scopes: string[];
}

/**
 * Token that resolved against the store. Either:
 *   - belongs to a user (legacy or new user-scoped token, `userId` set)
 *   - belongs to an org (service token, `orgId` set, `scopes` non-empty)
 *
 * The `tokens_owner_xor` constraint at the DB level guarantees exactly one
 * of the two is non-null.
 */
export interface ResolvedToken {
  userId: string | null;
  orgId: string | null;
  scopes: string[];
}

/** Granular scopes recognised by the API. */
export type TokenScope =
  | 'read'
  | 'write'
  | 'admin'
  | `space:${string}`
  | `org:${string}`;

export class DrizzleTokensRepository implements TokenStore {
  constructor(private readonly db: Db) {}

  // ── User tokens ────────────────────────────────────────────────────────

  /** Creates a USER token: returns the CLEARTEXT value once + the metadata. */
  async create(userId: string, name = 'token'): Promise<{ token: string; info: TokenInfo }> {
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(tokens)
      .values({ userId, tokenHash: hashToken(token), name })
      .returning();
    return {
      token,
      info: { id: row.id, name: row.name, createdAt: row.createdAt, scopes: row.scopes ?? [] },
    };
  }

  /** Legacy TokenStore interface — only resolves USER tokens (no org). */
  async findUserIdByToken(token: string): Promise<string | null> {
    const [row] = await this.db
      .select({ uid: tokens.userId })
      .from(tokens)
      .where(and(eq(tokens.tokenHash, hashToken(token)), isNotNull(tokens.userId)));
    return row?.uid ?? null;
  }

  async list(userId: string): Promise<TokenInfo[]> {
    return this.db
      .select({
        id: tokens.id,
        name: tokens.name,
        createdAt: tokens.createdAt,
        scopes: tokens.scopes,
      })
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

  // ── Org tokens (with scopes) ───────────────────────────────────────────

  /**
   * Create an ORG-scoped token. Returns the CLEARTEXT value once + metadata.
   * `scopes` is required; an empty scopes array would degrade to "full org
   * access", which is not what an explicit org-token call wants. Callers
   * must pass at least one scope.
   */
  async createOrgToken(
    orgId: string,
    name: string,
    scopes: TokenScope[],
  ): Promise<{ token: string; info: TokenInfo }> {
    if (scopes.length === 0) {
      throw new Error('org tokens require at least one scope');
    }
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.db
      .insert(tokens)
      .values({ orgId, tokenHash: hashToken(token), name, scopes })
      .returning();
    return {
      token,
      info: { id: row.id, name: row.name, createdAt: row.createdAt, scopes: row.scopes ?? [] },
    };
  }

  /** Lists ORG tokens (user tokens excluded). */
  async listForOrg(orgId: string): Promise<TokenInfo[]> {
    return this.db
      .select({
        id: tokens.id,
        name: tokens.name,
        createdAt: tokens.createdAt,
        scopes: tokens.scopes,
      })
      .from(tokens)
      .where(and(eq(tokens.orgId, orgId), isNull(tokens.userId)));
  }

  async revokeOrgToken(orgId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(tokens)
      .where(and(eq(tokens.id, id), eq(tokens.orgId, orgId), isNull(tokens.userId)))
      .returning({ id: tokens.id });
    return rows.length > 0;
  }

  /**
   * Full resolution — returns the (user|org, scopes) tuple for a Bearer
   * token. Used by `SessionAuthProvider` and by future MCP scope-checking.
   */
  async resolveToken(token: string): Promise<ResolvedToken | null> {
    const [row] = await this.db
      .select({ userId: tokens.userId, orgId: tokens.orgId, scopes: tokens.scopes })
      .from(tokens)
      .where(eq(tokens.tokenHash, hashToken(token)));
    if (!row) return null;
    return { userId: row.userId, orgId: row.orgId, scopes: row.scopes ?? [] };
  }
}
