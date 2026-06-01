import { eq } from 'drizzle-orm';
import type { YjsStateRepository } from '@diluxite/core';
import type { Db } from './client';
import { notes } from './schema';

/**
 * Postgres-backed Yjs state repo. Stored as bytea on the same notes row to
 * keep authorization simple (one row, one RLS policy, one ownership chain).
 *
 * No content_md derivation here — that lives in the Hocuspocus persist hook
 * which decodes the doc + writes both content_md and yjs_state in the same
 * transaction. This repo is the raw byte-bag.
 */
export class DrizzleYjsStateRepository implements YjsStateRepository {
  constructor(private readonly db: Db) {}

  async load(noteId: string): Promise<Uint8Array | null> {
    const [row] = await this.db
      .select({ state: notes.yjsState })
      .from(notes)
      .where(eq(notes.id, noteId));
    if (!row?.state) return null;
    // Buffer extends Uint8Array; return a view to keep callers tied to the
    // narrower contract and not Node-specific Buffer methods.
    return new Uint8Array(row.state.buffer, row.state.byteOffset, row.state.byteLength);
  }

  async save(noteId: string, state: Uint8Array): Promise<void> {
    const buf = Buffer.from(state.buffer, state.byteOffset, state.byteLength);
    await this.db
      .update(notes)
      .set({ yjsState: buf, yjsUpdatedAt: new Date() })
      .where(eq(notes.id, noteId));
  }

  async clear(noteId: string): Promise<void> {
    await this.db
      .update(notes)
      .set({ yjsState: null, yjsUpdatedAt: null })
      .where(eq(notes.id, noteId));
  }
}
