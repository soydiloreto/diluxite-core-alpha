import { and, eq } from 'drizzle-orm';
import type { SpaceAccess } from '@diluxite/core';
import type { Db } from './client';
import { espacios, miembros, usuarios } from './schema';

export interface Espacio {
  id: string;
  nombre: string;
  creado: Date;
}

export class DrizzleSpacesRepository implements SpaceAccess {
  constructor(private readonly db: Db) {}

  /** Espacios donde el usuario es miembro. */
  async listForUser(userId: string): Promise<Espacio[]> {
    return this.db
      .select({ id: espacios.id, nombre: espacios.nombre, creado: espacios.creado })
      .from(espacios)
      .innerJoin(miembros, eq(miembros.espacioId, espacios.id))
      .where(eq(miembros.usuarioId, userId));
  }

  async create(nombre: string, duenoId: string): Promise<Espacio> {
    const [s] = await this.db
      .insert(espacios)
      .values({ nombre, duenoId })
      .returning({ id: espacios.id, nombre: espacios.nombre, creado: espacios.creado });
    await this.db.insert(miembros).values({ espacioId: s.id, usuarioId: duenoId, rol: 'owner' });
    return s;
  }

  async isMember(spaceId: string, userId: string): Promise<boolean> {
    const [m] = await this.db
      .select({ rol: miembros.rol })
      .from(miembros)
      .where(and(eq(miembros.espacioId, spaceId), eq(miembros.usuarioId, userId)));
    return !!m;
  }

  async role(spaceId: string, userId: string): Promise<string | null> {
    const [m] = await this.db
      .select({ rol: miembros.rol })
      .from(miembros)
      .where(and(eq(miembros.espacioId, spaceId), eq(miembros.usuarioId, userId)));
    return m?.rol ?? null;
  }

  async addMember(spaceId: string, userId: string, rol = 'member'): Promise<void> {
    await this.db
      .insert(miembros)
      .values({ espacioId: spaceId, usuarioId: userId, rol })
      .onConflictDoNothing();
  }
}

export interface Usuario {
  id: string;
  email: string;
  proveedor: string | null;
}

export class DrizzleUsersRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<Usuario | null> {
    const [u] = await this.db.select().from(usuarios).where(eq(usuarios.email, email));
    return u ?? null;
  }

  async create(email: string, proveedor = 'local'): Promise<Usuario> {
    const [u] = await this.db.insert(usuarios).values({ email, proveedor }).returning();
    return u;
  }

  async ensureByEmail(email: string, proveedor = 'local'): Promise<Usuario> {
    return (await this.findByEmail(email)) ?? (await this.create(email, proveedor));
  }
}

/**
 * Bootstrap de la edición Core (single-user, sin login): garantiza un usuario
 * local y un espacio por defecto. Idempotente.
 */
export async function ensureSingleUserBootstrap(
  db: Db,
): Promise<{ userId: string; espacioId: string }> {
  const email = 'local@diluxite';
  let [u] = await db.select().from(usuarios).where(eq(usuarios.email, email));
  if (!u) {
    [u] = await db.insert(usuarios).values({ email, proveedor: 'local' }).returning();
  }
  let [s] = await db.select().from(espacios).where(eq(espacios.duenoId, u.id)).limit(1);
  if (!s) {
    [s] = await db.insert(espacios).values({ nombre: 'Mi espacio', duenoId: u.id }).returning();
    await db.insert(miembros).values({ espacioId: s.id, usuarioId: u.id, rol: 'owner' });
  }
  return { userId: u.id, espacioId: s.id };
}
