import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { folders } from './schema';

export interface Folder {
  id: string;
  spaceId: string;
  parentId: string | null;
  name: string;
  createdAt: Date;
}

export class DrizzleFoldersRepository {
  constructor(private readonly db: Db) {}

  /** Returns ALL folders in the space (flat). The client builds the tree. */
  async list(spaceId: string): Promise<Folder[]> {
    return this.db.select().from(folders).where(eq(folders.spaceId, spaceId));
  }

  async create(spaceId: string, name: string, parentId: string | null): Promise<Folder> {
    const [row] = await this.db
      .insert(folders)
      .values({ spaceId, name, parentId })
      .returning();
    return row;
  }

  async rename(id: string, name: string): Promise<Folder | null> {
    const [row] = await this.db
      .update(folders)
      .set({ name })
      .where(eq(folders.id, id))
      .returning();
    return row ?? null;
  }

  async move(id: string, parentId: string | null): Promise<Folder | null> {
    const [row] = await this.db
      .update(folders)
      .set({ parentId })
      .where(eq(folders.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(folders)
      .where(eq(folders.id, id))
      .returning({ id: folders.id });
    return rows.length > 0;
  }

  /** Owning space of the folder — useful to authorise before touching it. */
  async spaceOf(id: string): Promise<string | null> {
    const [r] = await this.db
      .select({ spaceId: folders.spaceId })
      .from(folders)
      .where(eq(folders.id, id));
    return r?.spaceId ?? null;
  }
}
