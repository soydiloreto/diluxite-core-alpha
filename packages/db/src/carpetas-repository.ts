import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { carpetas } from './schema';

export interface Carpeta {
  id: string;
  espacioId: string;
  padreId: string | null;
  nombre: string;
  creado: Date;
}

export class DrizzleCarpetasRepository {
  constructor(private readonly db: Db) {}

  /** Devuelve TODAS las carpetas del espacio (flat). El cliente arma el árbol. */
  async list(espacioId: string): Promise<Carpeta[]> {
    return this.db.select().from(carpetas).where(eq(carpetas.espacioId, espacioId));
  }

  async create(espacioId: string, nombre: string, padreId: string | null): Promise<Carpeta> {
    const [c] = await this.db
      .insert(carpetas)
      .values({ espacioId, nombre, padreId })
      .returning();
    return c;
  }

  async rename(id: string, nombre: string): Promise<Carpeta | null> {
    const [c] = await this.db
      .update(carpetas)
      .set({ nombre })
      .where(eq(carpetas.id, id))
      .returning();
    return c ?? null;
  }

  async mover(id: string, padreId: string | null): Promise<Carpeta | null> {
    const [c] = await this.db
      .update(carpetas)
      .set({ padreId })
      .where(eq(carpetas.id, id))
      .returning();
    return c ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(carpetas)
      .where(eq(carpetas.id, id))
      .returning({ id: carpetas.id });
    return rows.length > 0;
  }

  /** Espacio dueño de la carpeta — útil para autorizar antes de tocarla. */
  async espacioDe(id: string): Promise<string | null> {
    const [r] = await this.db
      .select({ espacioId: carpetas.espacioId })
      .from(carpetas)
      .where(eq(carpetas.id, id));
    return r?.espacioId ?? null;
  }
}
