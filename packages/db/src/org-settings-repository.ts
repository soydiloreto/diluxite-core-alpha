import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { orgSettings } from './schema';

/**
 * Per-org runtime settings — read/written from the Admin UI.
 *
 * Today only `authPolicy` lives here. It answers "what to do when an
 * external IdP authenticates an email that doesn't exist in our users
 * table" — see schema.ts for the three valid values.
 *
 * The table is sparse: rows are written on first change. If a row is
 * missing for an org, the system uses the schema default
 * (`allow_unknown_as_member`).
 */
export type AuthPolicy =
  | 'deny_unknown'
  | 'allow_unknown_as_member'
  | 'pre_provisioned_only';

const DEFAULT_AUTH_POLICY: AuthPolicy = 'allow_unknown_as_member';

function isValidPolicy(v: string): v is AuthPolicy {
  return (
    v === 'deny_unknown' ||
    v === 'allow_unknown_as_member' ||
    v === 'pre_provisioned_only'
  );
}

export class DrizzleOrgSettingsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Returns the auth policy for an org. Falls back to the system default if
   * no row exists yet (sparse table — see above).
   */
  async getAuthPolicy(orgId: string): Promise<AuthPolicy> {
    const [row] = await this.db
      .select({ p: orgSettings.authPolicy })
      .from(orgSettings)
      .where(eq(orgSettings.orgId, orgId));
    if (!row) return DEFAULT_AUTH_POLICY;
    if (isValidPolicy(row.p)) return row.p;
    // Hard belt-and-braces — shouldn't happen because of the CHECK
    // constraint, but if a migration accidentally inserts garbage we
    // fall back to the safest default rather than crash auth.
    return DEFAULT_AUTH_POLICY;
  }

  /**
   * Upsert the auth policy. Idempotent: re-writing the same value is a no-op
   * apart from bumping `updated_at`.
   */
  async setAuthPolicy(orgId: string, policy: AuthPolicy): Promise<void> {
    await this.db
      .insert(orgSettings)
      .values({ orgId, authPolicy: policy })
      .onConflictDoUpdate({
        target: orgSettings.orgId,
        set: { authPolicy: policy, updatedAt: new Date() },
      });
  }

  /**
   * The org's search configuration, with defaults when no row exists.
   *
   * The table is sparse on purpose, so absence means "never configured" and
   * has to read as the defaults rather than as zeros.
   */
  async getSearchConfig(orgId: string): Promise<{ mode: SearchMode; topK: number }> {
    const [row] = await this.db
      .select({ mode: orgSettings.searchMode, topK: orgSettings.searchTopK })
      .from(orgSettings)
      .where(eq(orgSettings.orgId, orgId));
    if (!row) return { ...DEFAULT_SEARCH_CONFIG };
    return {
      mode: isSearchMode(row.mode) ? row.mode : DEFAULT_SEARCH_CONFIG.mode,
      topK: row.topK,
    };
  }

  /**
   * Upsert the search configuration.
   *
   * Validated here as well as by the CHECK constraint: a route should get a
   * refusal it can turn into a 400, not a database error it turns into a 500.
   */
  async setSearchConfig(orgId: string, cfg: { mode: SearchMode; topK: number }): Promise<void> {
    if (!isSearchMode(cfg.mode)) throw new Error(`invalid search mode: ${cfg.mode}`);
    if (!Number.isInteger(cfg.topK) || cfg.topK < 1 || cfg.topK > MAX_SEARCH_TOP_K) {
      throw new Error(`topK out of range: ${cfg.topK}`);
    }
    await this.db
      .insert(orgSettings)
      .values({ orgId, searchMode: cfg.mode, searchTopK: cfg.topK })
      .onConflictDoUpdate({
        target: orgSettings.orgId,
        set: { searchMode: cfg.mode, searchTopK: cfg.topK, updatedAt: new Date() },
      });
  }
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

/** Matches the defaults the browser used, so an untouched install is unchanged. */
export const DEFAULT_SEARCH_CONFIG: { mode: SearchMode; topK: number } = {
  mode: 'hybrid',
  topK: 5,
};

/**
 * An upper bound as well as a lower one: topK feeds a candidate multiplier, so
 * a large value turns one query into a very expensive scan — for everyone in
 * the org, since this setting is shared.
 */
export const MAX_SEARCH_TOP_K = 50;

function isSearchMode(v: string): v is SearchMode {
  return v === 'hybrid' || v === 'keyword' || v === 'semantic';
}
