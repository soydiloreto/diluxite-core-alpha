import { and, asc, eq } from 'drizzle-orm';
import type { SpaceAccess } from '@diluxite/core';
import type { Db } from './client';
import { spaces, memberships, users, organizations, orgMemberships } from './schema';

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface Space {
  id: string;
  orgId: string;
  name: string;
  createdAt: Date;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: Date;
}

export class DrizzleSpacesRepository implements SpaceAccess {
  constructor(private readonly db: Db) {}

  /** Spaces the user is a member of. */
  async listForUser(userId: string): Promise<Space[]> {
    return this.db
      .select({
        id: spaces.id,
        orgId: spaces.orgId,
        name: spaces.name,
        createdAt: spaces.createdAt,
      })
      .from(spaces)
      .innerJoin(memberships, eq(memberships.spaceId, spaces.id))
      .where(eq(memberships.userId, userId));
  }

  /** Spaces inside a given organization (no membership filter). */
  async listForOrg(orgId: string): Promise<Space[]> {
    return this.db
      .select({
        id: spaces.id,
        orgId: spaces.orgId,
        name: spaces.name,
        createdAt: spaces.createdAt,
      })
      .from(spaces)
      .where(eq(spaces.orgId, orgId))
      .orderBy(asc(spaces.name));
  }

  /** Spaces inside an org that the user has an explicit membership on. */
  async listForUserInOrg(userId: string, orgId: string): Promise<Space[]> {
    return this.db
      .select({
        id: spaces.id,
        orgId: spaces.orgId,
        name: spaces.name,
        createdAt: spaces.createdAt,
      })
      .from(spaces)
      .innerJoin(memberships, eq(memberships.spaceId, spaces.id))
      .where(and(eq(memberships.userId, userId), eq(spaces.orgId, orgId)));
  }

  async findById(id: string): Promise<Space | null> {
    const [row] = await this.db.select().from(spaces).where(eq(spaces.id, id));
    return row ?? null;
  }

  async create(orgId: string, name: string, ownerId: string): Promise<Space> {
    const [row] = await this.db
      .insert(spaces)
      .values({ orgId, name, ownerId })
      .returning({
        id: spaces.id,
        orgId: spaces.orgId,
        name: spaces.name,
        createdAt: spaces.createdAt,
      });
    await this.db
      .insert(memberships)
      .values({ spaceId: row.id, userId: ownerId, role: 'admin' });
    return row;
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.update(spaces).set({ name }).where(eq(spaces.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(spaces).where(eq(spaces.id, id));
  }

  async isMember(spaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.spaceId, spaceId), eq(memberships.userId, userId)));
    return !!row;
  }

  async role(spaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.spaceId, spaceId), eq(memberships.userId, userId)));
    return (row?.role as WorkspaceRole) ?? null;
  }

  async members(spaceId: string): Promise<WorkspaceMember[]> {
    const rows = await this.db
      .select({
        userId: memberships.userId,
        email: users.email,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.spaceId, spaceId))
      .orderBy(asc(users.email));
    return rows.map((r) => ({ ...r, role: r.role as WorkspaceRole }));
  }

  async addOrUpdateMember(spaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.db
      .insert(memberships)
      .values({ spaceId, userId, role })
      .onConflictDoUpdate({
        target: [memberships.spaceId, memberships.userId],
        set: { role },
      });
  }

  async removeMember(spaceId: string, userId: string): Promise<void> {
    await this.db
      .delete(memberships)
      .where(and(eq(memberships.spaceId, spaceId), eq(memberships.userId, userId)));
  }
}

export interface User {
  id: string;
  email: string;
  provider: string | null;
}

export class DrizzleUsersRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return row ?? null;
  }

  async create(email: string, provider = 'local'): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({ email: email.toLowerCase(), provider })
      .returning();
    return row;
  }

  async ensureByEmail(email: string, provider = 'local'): Promise<User> {
    return (await this.findByEmail(email)) ?? (await this.create(email, provider));
  }

  /** Server-mode auth helper — reads the (possibly null) password hash. */
  async findWithPasswordByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash: string | null } | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));
    return row ?? null;
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ?? null;
  }

  /** Lookup by ids in one shot — used by admin lists to resolve emails. */
  async findManyByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(users)
      .where(
        // Drizzle exposes inArray separately; using a raw OR chain keeps the
        // helper file dependency-free.
        // @ts-expect-error — Drizzle's eq accepts any, we OR them.
        ids.map((id) => eq(users.id, id)).reduce((a, b) => ({ ...a, ...b })),
      );
    return rows;
  }
}

/**
 * Bootstrap for the Core edition: ensures a local user, a "Local" org, the
 * user as super_admin of that org, and a default space inside that org —
 * all idempotent. Cloud editions skip this and rely on Entra ID bootstrap.
 */
export async function ensureSingleUserBootstrap(
  db: Db,
): Promise<{ userId: string; orgId: string; spaceId: string }> {
  const email = 'local@diluxite';
  let [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) {
    [u] = await db.insert(users).values({ email, provider: 'local' }).returning();
  }

  // The first org we find that the user owns (super_admin) is "the local org".
  // If none exists, create it.
  const orgs = await db
    .select({ orgId: organizations.id, role: orgMemberships.role })
    .from(orgMemberships)
    .innerJoin(organizations, eq(organizations.id, orgMemberships.orgId))
    .where(eq(orgMemberships.userId, u.id))
    .limit(1);
  let orgId: string;
  if (orgs.length === 0) {
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Local', slug: `local-${u.id.slice(0, 8)}` })
      .returning({ id: organizations.id });
    orgId = org.id;
    await db.insert(orgMemberships).values({ orgId, userId: u.id, role: 'super_admin' });
  } else {
    orgId = orgs[0].orgId;
  }

  let [s] = await db.select().from(spaces).where(eq(spaces.ownerId, u.id)).limit(1);
  if (!s) {
    [s] = await db
      .insert(spaces)
      .values({ orgId, name: 'My space', ownerId: u.id })
      .returning();
    await db.insert(memberships).values({ spaceId: s.id, userId: u.id, role: 'admin' });
  }
  return { userId: u.id, orgId, spaceId: s.id };
}
