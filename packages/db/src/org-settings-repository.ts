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
}
