import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Db, DbTx } from './client';
import { organizations, orgMemberships, users } from './schema';

export type OrgRole = 'super_admin' | 'admin' | 'member';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface OrganizationMember {
  userId: string;
  email: string;
  role: OrgRole;
  joinedAt: Date;
}

export interface OrganizationWithRole extends OrganizationRow {
  /** Role of the user that requested the listing, within this org. */
  role: OrgRole;
}

/**
 * Read/write the org tier (above workspaces).
 *
 * Authorisation is layered: this repository enforces *who can see what*
 * (membership checks). Role-based gates on mutations live one layer up
 * in the API handlers so they can return 403 with a meaningful message.
 */
export class DrizzleOrganizationsRepository {
  constructor(private readonly db: Db) {}

  async listForUser(userId: string): Promise<OrganizationWithRole[]> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        createdAt: organizations.createdAt,
        role: orgMemberships.role,
      })
      .from(orgMemberships)
      .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
      .where(eq(orgMemberships.userId, userId))
      .orderBy(asc(organizations.name));
    return rows.map((r) => ({ ...r, role: r.role as OrgRole }));
  }

  async findById(id: string): Promise<OrganizationRow | null> {
    const [row] = await this.db.select().from(organizations).where(eq(organizations.id, id));
    return row ?? null;
  }

  async create(name: string, slug: string, ownerUserId: string): Promise<OrganizationRow> {
    // Both inserts in one transaction: an org without a super_admin is
    // invisible (member-visibility RLS) and can never be administered or
    // deleted again, so the two rows must commit together or not at all.
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(organizations)
        .values({ name, slug })
        .returning();
      await tx
        .insert(orgMemberships)
        .values({ orgId: row.id, userId: ownerUserId, role: 'super_admin' });
      return row;
    });
  }

  /**
   * Server-mode bootstrap helper — guarantees the given user belongs to at
   * least one org. If they already do, no-op. Otherwise creates one with
   * the given name (slugified) and makes them super_admin.
   */
  async ensureForUser(userId: string, name: string): Promise<OrganizationRow> {
    const existing = await this.listForUser(userId);
    if (existing.length > 0) return existing[0];
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'org';
    return this.create(name, `${slug}-${Math.random().toString(36).slice(2, 8)}`, userId);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(organizations).set({ name }).where(eq(organizations.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(organizations).where(eq(organizations.id, id));
  }

  // ── Membership ────────────────────────────────────────────────────────
  async roleOf(orgId: string, userId: string): Promise<OrgRole | null> {
    const [row] = await this.db
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)));
    return (row?.role as OrgRole) ?? null;
  }

  async members(orgId: string): Promise<OrganizationMember[]> {
    const rows = await this.db
      .select({
        userId: orgMemberships.userId,
        email: users.email,
        role: orgMemberships.role,
        joinedAt: orgMemberships.createdAt,
      })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(eq(orgMemberships.orgId, orgId))
      .orderBy(asc(users.email));
    return rows.map((r) => ({ ...r, role: r.role as OrgRole }));
  }

  /** Upsert: invites the user (or updates role if already a member). */
  async addOrUpdateMember(orgId: string, userId: string, role: OrgRole): Promise<void> {
    await this.db
      .insert(orgMemberships)
      .values({ orgId, userId, role })
      .onConflictDoUpdate({
        target: [orgMemberships.orgId, orgMemberships.userId],
        set: { role },
      });
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.db
      .delete(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)));
  }

  /**
   * Guard rail: an organization must keep at least one super_admin.
   * Returns true if removing `userId` (or demoting them) would leave none.
   *
   * NOTE: this is a plain read — `check-then-act` against it from the API
   * layer races (two concurrent demotes both pass the check, then both
   * commit, orphaning the org). Prefer `removeMemberGuarded` /
   * `demoteMemberGuarded`, which do the check + mutation atomically under a
   * row lock. Kept for backwards-compat / read-only callers.
   */
  async wouldOrphanSuperAdmin(orgId: string, userId: string): Promise<boolean> {
    return this.wouldOrphanSuperAdminTx(this.db, orgId, userId);
  }

  /**
   * Shared predicate. When run inside a transaction that already took
   * `FOR UPDATE` on the org's super_admin rows, the answer is stable for the
   * rest of the transaction — that's what makes the guarded mutations safe.
   */
  private async wouldOrphanSuperAdminTx(
    db: Db | DbTx,
    orgId: string,
    userId: string,
  ): Promise<boolean> {
    const others = await db
      .select({ userId: orgMemberships.userId })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, orgId),
          eq(orgMemberships.role, 'super_admin'),
          ne(orgMemberships.userId, userId),
        ),
      )
      .limit(1);
    return others.length === 0;
  }

  /**
   * Atomically remove a member, refusing if it would orphan the org's last
   * super_admin. Returns 'removed' on success or 'would_orphan' if blocked.
   *
   * Race-safety: we `SELECT … FOR UPDATE` the org's super_admin memberships
   * first, serialising concurrent demotes/removes of the same org — the
   * second transaction blocks until the first commits, then re-evaluates the
   * (now updated) count. Two concurrent attempts can no longer both pass.
   */
  async removeMemberGuarded(
    orgId: string,
    userId: string,
  ): Promise<'removed' | 'would_orphan'> {
    return this.db.transaction(async (tx) => {
      await this.lockSuperAdmins(tx, orgId);
      if (await this.wouldOrphanSuperAdminTx(tx, orgId, userId)) {
        return 'would_orphan';
      }
      await tx
        .delete(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)));
      return 'removed';
    });
  }

  /**
   * Atomically change a member's role, refusing a demotion that would orphan
   * the last super_admin. Returns 'updated' or 'would_orphan'.
   */
  async demoteMemberGuarded(
    orgId: string,
    userId: string,
    role: OrgRole,
  ): Promise<'updated' | 'would_orphan'> {
    return this.db.transaction(async (tx) => {
      await this.lockSuperAdmins(tx, orgId);
      if (role !== 'super_admin' && (await this.wouldOrphanSuperAdminTx(tx, orgId, userId))) {
        return 'would_orphan';
      }
      await tx
        .insert(orgMemberships)
        .values({ orgId, userId, role })
        .onConflictDoUpdate({
          target: [orgMemberships.orgId, orgMemberships.userId],
          set: { role },
        });
      return 'updated';
    });
  }

  /** Take a row lock on every super_admin membership of the org. */
  private async lockSuperAdmins(db: Db | DbTx, orgId: string): Promise<void> {
    await db.execute(
      sql`SELECT 1 FROM org_memberships
          WHERE org_id = ${orgId} AND role = 'super_admin'
          FOR UPDATE`,
    );
  }
}
