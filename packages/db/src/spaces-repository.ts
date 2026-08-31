import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
    // Both inserts in one transaction: a space without an admin membership is
    // invisible (no member can see it) yet undeletable through the UI, so the
    // two rows must land together or not at all.
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(spaces)
        .values({ orgId, name, ownerId })
        .returning({
          id: spaces.id,
          orgId: spaces.orgId,
          name: spaces.name,
          createdAt: spaces.createdAt,
        });
      await tx
        .insert(memberships)
        .values({ spaceId: row.id, userId: ownerId, role: 'admin' });
      return row;
    });
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

  /**
   * True when the space belongs to `orgId`. Authorises ORG tokens, which have
   * no per-space membership — their reach is every space inside their org.
   */
  async isSpaceInOrg(spaceId: string, orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ one: sql<number>`1` })
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)));
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
  /** Optional display name parts, populated by CSV import + OIDC claims. */
  firstName?: string | null;
  lastName?: string | null;
  /** Soft-disable: false means "the admin disabled this account". */
  active?: boolean;
  /** When the user last successfully authenticated, or null if never. */
  lastLoginAt?: Date | null;
  passwordHash?: string | null;
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
  ): Promise<{ id: string; email: string; passwordHash: string | null; active: boolean } | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        active: users.active,
      })
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

  // ─── Enterprise / SSO support (alpha.24+) ──────────────────────────────

  /**
   * Mark a user as soft-disabled. Active=false means "the IdP can still
   * authenticate this email but Diluxite refuses to issue them a session" —
   * preserves history (notes, audit log) while cutting access.
   */
  async setActive(userId: string, active: boolean): Promise<void> {
    await this.db.update(users).set({ active }).where(eq(users.id, userId));
  }

  /**
   * Stamp last_login_at = NOW(). Called from AuthProvider.resolve()
   * on every successful resolve so admins can spot idle accounts.
   */
  async touchLastLogin(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  /**
   * JIT provisioning entry point. Called when an external IdP authenticates
   * a user that doesn't exist locally yet. Returns the created user.
   * Provider mirrors what the AuthProvider that called us identifies as
   * (e.g. 'oidc', 'trusted_header').
   */
  async createFromExternal(input: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    provider: string;
  }): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        provider: input.provider,
      })
      .returning();
    return row;
  }

  /**
   * CSV import upsert — admin uploads a (email, firstName, lastName) tuple.
   * Idempotent by email: existing users get their names patched (only the
   * fields that arrived non-null), new users are created with provider='csv_import'.
   * Returns 'created' | 'updated' so the import endpoint can report counts.
   */
  /**
   * Whether this account owns the INSTALLATION — ADR-005.
   *
   * Instance-wide settings ask this; tenant data never does. A setup_admin
   * reading an organisation's notes still needs membership in it, which is
   * the property that keeps an operator from being a silent superuser over
   * their customers.
   */
  async isSetupAdmin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ setupAdmin: users.setupAdmin })
      .from(users)
      .where(eq(users.id, userId));
    return row?.setupAdmin === true;
  }

  /** Promote or demote an installation owner. Refuses to leave zero. */
  async setSetupAdmin(userId: string, value: boolean): Promise<'ok' | 'would_orphan'> {
    if (value) {
      await this.db.update(users).set({ setupAdmin: true }).where(eq(users.id, userId));
      return 'ok';
    }
    // Locked and counted in one transaction: two concurrent demotions of the
    // last two owners would each see one remaining and leave none.
    return this.db.transaction(async (tx) => {
      const owners = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.setupAdmin, true))
        .for('update');
      if (owners.length <= 1 && owners.some((o) => o.id === userId)) return 'would_orphan';
      await tx.update(users).set({ setupAdmin: false }).where(eq(users.id, userId));
      return 'ok';
    });
  }

  async upsertFromCsv(input: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<{ user: User; outcome: 'created' | 'updated' }> {
    const email = input.email.toLowerCase();
    const existing = await this.findByEmail(email);
    if (existing) {
      const patch: Partial<{ firstName: string; lastName: string }> = {};
      if (input.firstName) patch.firstName = input.firstName;
      if (input.lastName) patch.lastName = input.lastName;
      if (Object.keys(patch).length > 0) {
        await this.db.update(users).set(patch).where(eq(users.id, existing.id));
      }
      const [refreshed] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, existing.id));
      return { user: refreshed, outcome: 'updated' };
    }
    const [row] = await this.db
      .insert(users)
      .values({
        email,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        provider: 'csv_import',
      })
      .returning();
    return { user: row, outcome: 'created' };
  }

  /** Lookup by ids in one shot — used by admin lists to resolve emails. */
  async findManyByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(users).where(inArray(users.id, ids));
  }
}

/**
 * Bootstrap for the Core edition: ensures a local user, a "Local" org, the
 * user as org_admin of that org, and a default space inside that org —
 * all idempotent. Cloud editions skip this and rely on Entra ID bootstrap.
 */
export async function ensureSingleUserBootstrap(
  db: Db,
): Promise<{ userId: string; orgId: string; spaceId: string }> {
  const email = 'local@diluxite';
  let [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) {
    // ADR-005: whoever ran the installer owns the installation. On a fresh
    // install that is this account, and it is the only moment the answer is
    // unambiguous — later there may be several organisations, each with its
    // own admin, and none of them is obviously "the operator".
    [u] = await db.insert(users).values({ email, provider: 'local', setupAdmin: true }).returning();
  }

  // An installation with no setup_admin cannot be configured at all, so a
  // database that arrives without one (an upgrade, a restored backup taken
  // before ADR-005) gets this account promoted rather than being left stuck.
  const [{ n: owners }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.setupAdmin, true));
  if (Number(owners) === 0) {
    await db.update(users).set({ setupAdmin: true }).where(eq(users.id, u.id));
  }

  // The first org we find that the user owns (org_admin) is "the local org".
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
    await db.insert(orgMemberships).values({ orgId, userId: u.id, role: 'org_admin' });
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
