import { and, eq } from 'drizzle-orm';
import type { SpaceAccess } from '@diluxite/core';
import type { Db } from './client';
import { spaces, memberships, users } from './schema';

export interface Space {
  id: string;
  name: string;
  createdAt: Date;
}

export class DrizzleSpacesRepository implements SpaceAccess {
  constructor(private readonly db: Db) {}

  /** Spaces the user is a member of. */
  async listForUser(userId: string): Promise<Space[]> {
    return this.db
      .select({ id: spaces.id, name: spaces.name, createdAt: spaces.createdAt })
      .from(spaces)
      .innerJoin(memberships, eq(memberships.spaceId, spaces.id))
      .where(eq(memberships.userId, userId));
  }

  async create(name: string, ownerId: string): Promise<Space> {
    const [row] = await this.db
      .insert(spaces)
      .values({ name, ownerId })
      .returning({ id: spaces.id, name: spaces.name, createdAt: spaces.createdAt });
    await this.db
      .insert(memberships)
      .values({ spaceId: row.id, userId: ownerId, role: 'owner' });
    return row;
  }

  async isMember(spaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.spaceId, spaceId), eq(memberships.userId, userId)));
    return !!row;
  }

  async role(spaceId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.spaceId, spaceId), eq(memberships.userId, userId)));
    return row?.role ?? null;
  }

  async addMember(spaceId: string, userId: string, role = 'member'): Promise<void> {
    await this.db
      .insert(memberships)
      .values({ spaceId, userId, role })
      .onConflictDoNothing();
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
    const [row] = await this.db.select().from(users).where(eq(users.email, email));
    return row ?? null;
  }

  async create(email: string, provider = 'local'): Promise<User> {
    const [row] = await this.db.insert(users).values({ email, provider }).returning();
    return row;
  }

  async ensureByEmail(email: string, provider = 'local'): Promise<User> {
    return (await this.findByEmail(email)) ?? (await this.create(email, provider));
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ?? null;
  }
}

/**
 * Bootstrap for the Core edition (single-user, no login): ensures a local user
 * and a default space exist. Idempotent.
 */
export async function ensureSingleUserBootstrap(
  db: Db,
): Promise<{ userId: string; spaceId: string }> {
  const email = 'local@diluxite';
  let [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) {
    [u] = await db.insert(users).values({ email, provider: 'local' }).returning();
  }
  let [s] = await db.select().from(spaces).where(eq(spaces.ownerId, u.id)).limit(1);
  if (!s) {
    [s] = await db.insert(spaces).values({ name: 'My space', ownerId: u.id }).returning();
    await db.insert(memberships).values({ spaceId: s.id, userId: u.id, role: 'owner' });
  }
  return { userId: u.id, spaceId: s.id };
}
