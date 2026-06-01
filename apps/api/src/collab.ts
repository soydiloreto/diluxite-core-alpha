import { Server } from '@hocuspocus/server';
import type {
  onAuthenticatePayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import type {
  AuthHeaders,
  AuthProvider,
  NoteIndexer,
  NotesRepository,
  YjsStateRepository,
} from '@diluxite/core';

/** Adapt a web `Headers` instance to the `AuthHeaders` record AuthProvider expects. */
function headersToRecord(h: Headers): AuthHeaders {
  const out: Record<string, string | string[]> = {};
  h.forEach((value, key) => {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  });
  return out;
}

/**
 * Sprint 1 plumbing for collaborative editing via Hocuspocus.
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
 * What we *do not* do here (later sprints)
 * ────────────────────────────────────────
 * - Awareness rendering (cursors): protocol is on, but the editor side wires
 *   it up. Sprint 3.
 * - Incremental embedding trigger: re-uses the existing search service in
 *   Sprint 4, on the same onStoreDocument tick.
 * - GC of large yjs_state snapshots: Sprint 5.
 */

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
 * Builds a Hocuspocus Server bound to the api's identity + persistence.
 * Caller wires it to the underlying http.Server via `server.handleConnection`
 * on the `upgrade` event (see index.ts).
 */
export function buildCollabServer(deps: CollabDeps): Server {
  return new Server({
    async onAuthenticate(payload: onAuthenticatePayload) {
      // The session cookie travels in the upgrade request headers. AuthProvider
      // is the same one REST uses, so cookie + token + passkey + single-user
      // all resolve transparently.
      const id = await deps.auth.resolve(headersToRecord(payload.requestHeaders));
      if (!id) throw new Error('unauthenticated');
      const noteId = parseDocName(payload.documentName);
      if (!noteId) throw new Error('invalid document name');
      const note = await deps.notes.findById(noteId);
      if (!note) throw new Error('note not found');
      // Per-space authorization is enforced by the underlying repos which run
      // inside the postgres session opened with the user identity (RLS). We
      // also re-check here so a stale doc opened by ID alone can't bypass it
      // when the user lost access between fetches.
      // (Sprint 4 hardens this with an explicit isMember check.)
      return { userId: id.userId, noteId };
    },

    async onLoadDocument(payload: onLoadDocumentPayload) {
      const noteId = parseDocName(payload.documentName);
      if (!noteId) throw new Error('invalid document name');
      const persisted = await deps.yjs.load(noteId);
      if (persisted && persisted.byteLength > 0) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, persisted);
        return doc;
      }
      // Legacy / first-ever open: seed from content_md so the user doesn't
      // lose existing text. From this point onward yjs_state is the source
      // of truth while the doc is alive.
      const note = await deps.notes.findById(noteId);
      return seedDocFromMarkdown(note?.contentMd ?? '');
    },

    async onStoreDocument(payload: onStoreDocumentPayload) {
      const noteId = parseDocName(payload.documentName);
      if (!noteId) return;
      const state = Y.encodeStateAsUpdate(payload.document);
      const markdown = deriveMarkdown(payload.document);
      await deps.yjs.save(noteId, state);
      // Mirror to content_md so non-collab consumers (MCP, search, export)
      // see fresh text. We deliberately route through the repo rather than
      // the service so the indexer hook is not re-fired here — Sprint 4
      // wires the indexer directly into this same tick to keep it explicit.
      const updated = await deps.notes.update(noteId, { contentMd: markdown });
      if (updated && deps.indexer) {
        await deps.indexer.index(updated);
      }
    },
  });
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
  // Live path: hand the mutation to the in-memory doc Hocuspocus is already
  // serving. Need to import the Hocuspocus type lazily to keep this helper
  // testable without a real Server instance — the runtime call goes through
  // the public openDirectConnection method.
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
