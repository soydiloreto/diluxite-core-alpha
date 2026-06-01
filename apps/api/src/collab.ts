import { Hocuspocus } from '@hocuspocus/server';
import type {
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import type { IncomingHttpHeaders } from 'http';
import * as Y from 'yjs';
import type {
  AuthHeaders,
  AuthProvider,
  NoteIndexer,
  NotesRepository,
  YjsStateRepository,
} from '@diluxite/core';

/**
 * Sprint 1-6 plumbing for collaborative editing via Hocuspocus 2.x.
 *
 * Architecture
 * ────────────
 * - Each note maps 1:1 to a Hocuspocus "document" whose name is `note:<id>`.
 * - Hocuspocus holds the Y.Doc in memory while ≥1 client is connected and
 *   synchronizes ops via WebSocket using Yjs's sync protocol + awareness.
 * - On `onLoadDocument` we hydrate from the YjsStateRepository (Postgres
 *   bytea). If the column is null (legacy note or never edited collaboratively)
 *   we seed a Y.Doc from notes.content_md so semantic continuity is preserved.
 * - On `onStoreDocument` we persist the binary state AND derive markdown back
 *   to notes.content_md so MCP / search / export keep seeing fresh text.
 *   Hocuspocus debounces this hook by default (~2s) — we don't add ours on
 *   top.
 * - `onAuthenticate` reuses the api's AuthProvider to resolve identity from
 *   the connection cookie; if it fails the upgrade is rejected.
 *
 * Why Hocuspocus 2.x and not 4.x
 * ──────────────────────────────
 * The 4.x line replaced the `ws` transport with `crossws`. Diagnosed live
 * against alpha.11: WebSocket upgrades succeed but the initial sync never
 * flows — both browser and Node clients hang in "connected, not synced".
 * 2.x uses `ws` directly and works.
 */

/**
 * Adapt Node's IncomingHttpHeaders to the AuthHeaders record AuthProvider
 * expects. They're already very close; just narrow undefined to skip empties.
 */
function headersToRecord(h: IncomingHttpHeaders): AuthHeaders {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export interface CollabDeps {
  auth: AuthProvider;
  notes: NotesRepository;
  yjs: YjsStateRepository;
  /** Optional indexer hook to reindex after a persist tick. Sprint 4. */
  indexer?: NoteIndexer;
}

/** The shared `Y.Text` key that holds the markdown body. */
export const Y_TEXT_KEY = 'markdown';

/** Document name → noteId. Inverse of `noteDocName`. */
export function parseDocName(name: string): string | null {
  const m = /^note:([0-9a-f-]{36})$/i.exec(name);
  return m ? m[1] : null;
}

/** Conventional document name for a note. */
export function noteDocName(noteId: string): string {
  return `note:${noteId}`;
}

/** Derive the current markdown body from a Y.Doc. */
export function deriveMarkdown(doc: Y.Doc): string {
  return doc.getText(Y_TEXT_KEY).toString();
}

/** Seed a fresh Y.Doc with an initial markdown body. */
export function seedDocFromMarkdown(md: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(Y_TEXT_KEY).insert(0, md);
  return doc;
}

/**
 * Compaction note
 * ────────────────
 * We deliberately don't run a custom GC loop on `yjs_state`. Two reasons:
 *
 *  1. `Y.Doc.gc` is `true` by default — Yjs already drops tombstones from
 *     deleted items in-memory.
 *  2. Every time `onStoreDocument` fires we serialize with
 *     `Y.encodeStateAsUpdate(doc)`, which returns the current minimal state
 *     rather than the append-only log. That IS the compaction step — the
 *     persisted byte payload is the smallest representation Yjs can produce
 *     for the doc at that moment.
 *
 * If we ever need to shrink huge legacy `yjs_state` blobs (e.g. notes that
 * accumulated thousands of CRDT operations before we started encoding
 * snapshots), the recipe is: load → new Doc → applyUpdate → re-encode →
 * save. That's a one-off batch, not a recurring task. The lazy
 * `onLoadDocument` path effectively does this any time a stale state is
 * opened.
 */

/**
 * Builds a Hocuspocus instance bound to the api's identity + persistence.
 * Caller calls `.listen(port)` to start the WebSocket server.
 */
export function buildCollabServer(deps: CollabDeps): Hocuspocus {
  const server = new Hocuspocus();
  server.configure({
    // NOTE: we deliberately do NOT register `onAuthenticate`. In Hocuspocus 2.x
    // having `onAuthenticate` flips `requiresAuthentication = true`, which
    // rejects any client that doesn't send a `token` field — and our browser
    // clients identify by session cookie, not by an explicit token. The auth
    // check lives in `onLoadDocument` instead, which still has access to
    // requestHeaders (so cookies + Bearer tokens both resolve), but is not
    // gated by the "must have token" handshake step.

    async onLoadDocument(payload: onLoadDocumentPayload) {
      const id = await deps.auth.resolve(headersToRecord(payload.requestHeaders));
      if (!id) throw new Error('unauthenticated');
      const noteId = parseDocName(payload.documentName);
      if (!noteId) throw new Error('invalid document name');
      const note = await deps.notes.findById(noteId);
      if (!note) throw new Error('note not found');
      const persisted = await deps.yjs.load(noteId);
      if (persisted && persisted.byteLength > 0) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, persisted);
        return doc;
      }
      // Legacy / first-ever open: seed from content_md so the user doesn't
      // lose existing text. From this point onward yjs_state is the source
      // of truth while the doc is alive.
      return seedDocFromMarkdown(note.contentMd ?? '');
    },

    async onStoreDocument(payload: onStoreDocumentPayload) {
      const noteId = parseDocName(payload.documentName);
      if (!noteId) return;
      const state = Y.encodeStateAsUpdate(payload.document);
      const markdown = deriveMarkdown(payload.document);
      await deps.yjs.save(noteId, state);
      // Mirror to content_md so non-collab consumers (MCP, search, export)
      // see fresh text. Route through the repo rather than the service so
      // the indexer hook is fired here explicitly (Sprint 4 logic).
      const updated = await deps.notes.update(noteId, { contentMd: markdown });
      if (updated && deps.indexer) {
        await deps.indexer.index(updated);
      }
    },
  });
  return server;
}

/**
 * Server-authored write to a note's Y.Text — the path MCP `append` and any
 * other programmatic edit takes when collab is on.
 *
 * Two flavours, chosen by whether there's a live Hocuspocus doc in memory:
 *
 *  - LIVE  (≥1 client connected): open a DirectConnection to the existing
 *    document. The transaction mutates the live Y.Doc, which Hocuspocus
 *    broadcasts to every connected client and persists via onStoreDocument.
 *    Connected editors see the change appear in real time.
 *
 *  - COLD  (no clients): load the persisted state (or seed from content_md
 *    for legacy notes), apply, persist, mirror content_md. Same end state
 *    as the live path, no broadcast.
 *
 * The `hocuspocus` param is optional — without it the helper always takes
 * the COLD path, which is exactly what the unit tests want.
 */
export async function applyServerEdit(
  deps: CollabDeps,
  noteId: string,
  mutate: (text: Y.Text) => void,
  hocuspocus?: { documents: Map<string, { name: string }> } | null,
): Promise<string> {
  const docName = noteDocName(noteId);
  const liveDoc = hocuspocus?.documents.get(docName);
  if (liveDoc && hocuspocus && 'openDirectConnection' in hocuspocus) {
    const h = hocuspocus as unknown as {
      openDirectConnection: (name: string) => Promise<{
        transact: (fn: (doc: Y.Doc) => void) => Promise<void>;
        disconnect: () => Promise<void>;
        document: Y.Doc;
      }>;
    };
    const conn = await h.openDirectConnection(docName);
    let observed = '';
    await conn.transact((doc) => {
      mutate(doc.getText(Y_TEXT_KEY));
      observed = doc.getText(Y_TEXT_KEY).toString();
    });
    await conn.disconnect();
    return observed;
  }

  // Cold path: there's no live doc — load, mutate, persist, mirror.
  const persisted = await deps.yjs.load(noteId);
  const doc = new Y.Doc();
  if (persisted && persisted.byteLength > 0) {
    Y.applyUpdate(doc, persisted);
  } else {
    const note = await deps.notes.findById(noteId);
    if (note?.contentMd) doc.getText(Y_TEXT_KEY).insert(0, note.contentMd);
  }
  mutate(doc.getText(Y_TEXT_KEY));
  const state = Y.encodeStateAsUpdate(doc);
  await deps.yjs.save(noteId, state);
  const markdown = deriveMarkdown(doc);
  await deps.notes.update(noteId, { contentMd: markdown });
  doc.destroy();
  return markdown;
}
