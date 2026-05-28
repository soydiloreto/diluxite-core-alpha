import { and, asc, eq, ne } from 'drizzle-orm';
import type { Db } from './client';
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
    const [row] = await this.db
      .insert(organizations)
      .values({ name, slug })
      .returning();
    await this.db
      .insert(orgMemberships)
      .values({ orgId: row.id, userId: ownerUserId, role: 'super_admin' });
    return row;
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
   */
  async wouldOrphanSuperAdmin(orgId: string, userId: string): Promise<boolean> {
    const others = await this.db
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
}
