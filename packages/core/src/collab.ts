/**
 * Collaborative editing — Yjs CRDT state persistence port.
 *
 * Sprint 1 plumbing: while clients are connected to a note via Hocuspocus the
 * in-memory Y.Doc is authoritative. This port lets the api layer snapshot the
 * binary state to durable storage (typically Postgres bytea) on a debounced
 * tick, and hydrate the doc back on the next open.
 *
 * Kept minimal on purpose: load/save/clear is enough for now. Future
 * sprints add presence (awareness in-memory, ephemeral) and snapshot
 * compaction (out-of-band, doesn't need this port).
 */
export interface YjsStateRepository {
  /** Returns the persisted binary state for a note, or null if never saved. */
  load(noteId: string): Promise<Uint8Array | null>;
  /** Persists the binary state + bumps yjs_updated_at. */
  save(noteId: string, state: Uint8Array): Promise<void>;
  /** Drops the Yjs state (e.g. on note delete). */
  clear(noteId: string): Promise<void>;
}
