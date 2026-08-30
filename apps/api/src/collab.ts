import { Hocuspocus } from '@hocuspocus/server';
import type {
  onConnectPayload,
  onLoadDocumentPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import type { IncomingHttpHeaders } from 'http';
import * as Y from 'yjs';
import { canReadSpace, canWriteSpace } from '@diluxite/core';
import type {
  AuthHeaders,
  AuthProvider,
  NoteIndexer,
  NotesRepository,
  SpaceAuthzDeps,
  WriteAttribution,
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
 *
 * Re-tested at 4.6.0 during the dependency sweep, and it still does not sync.
 * The migration itself is small and was carried out in full (`Server` now owns
 * the `Hocuspocus` instance that holds `documents`/`openDirectConnection`, and
 * hook payloads carry a WHATWG `Headers` instead of Node's
 * `IncomingHttpHeaders`) — that part was not the problem. What failed is the
 * transport: every integration test that drives a REAL WebSocket failed while
 * all eight that go through `openDirectConnection` passed. Reduced to a probe
 * with NO Diluxite code in it — a bare `new Server({ onLoadDocument })` plus a
 * 4.6.0 `HocuspocusProvider` over `ws` — the client's document stayed empty and
 * not one status event fired. So this pin is not staleness, and bumping it
 * without a real-WebSocket check in front of you will silently ship an editor
 * that never receives its own document.
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

/**
 * Deps for the WebSocket server itself. On top of the shared CollabDeps it
 * REQUIRES the authorisation ports (satisfied by the Drizzle repositories):
 * every incoming connection is authorised against the note's space with the
 * SAME rule as REST and MCP, imported from core rather than restated here.
 *
 * This used to be `Pick<SpaceAccess, 'isMember' | 'isSpaceInOrg'>` and that
 * narrowness WAS the bug: membership alone let a `viewer` type into a live
 * document, and the org branch never looked at scopes at all, so a read-only
 * token could have edited over the socket — the one surface where REST's
 * `write` scope check did not apply.
 *
 * `applyServerEdit` keeps the narrower CollabDeps because server-authored
 * edits run after the REST/MCP layer already authorised the caller.
 */
export type CollabServerDeps = CollabDeps & SpaceAuthzDeps;

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
export function buildCollabServer(deps: CollabServerDeps): Hocuspocus {
  // Shared auth + authorisation for an incoming connection: resolve identity
  // from the request headers (cookie or Bearer), then apply the SAME space
  // rule as REST and MCP (`canReadSpace` / `canWriteSpace` from core). In
  // local single-user mode the SingleUserAuthProvider resolves the bootstrap
  // user, who is an admin of every space they own, so both answers are true
  // and the check is a no-op there.
  //
  // Returns whether the connection may WRITE. Throwing rejects it outright,
  // which is reserved for callers who cannot even READ.
  async function authorizeConnection(
    requestHeaders: IncomingHttpHeaders,
    documentName: string,
  ): Promise<{ canWrite: boolean }> {
    const id = await deps.auth.resolve(headersToRecord(requestHeaders));
    if (!id) throw new Error('unauthenticated');
    const noteId = parseDocName(documentName);
    if (!noteId) throw new Error('invalid document name');
    const note = await deps.notes.findById(noteId);
    if (!note) throw new Error('note not found');
    if (!(await canReadSpace(deps, id, note.spaceId))) {
      throw new Error('forbidden: no access to this space');
    }
    return { canWrite: await canWriteSpace(deps, id, note.spaceId) };
  }

  const server = new Hocuspocus();
  server.configure({
    // NOTE: we deliberately do NOT register `onAuthenticate`. In Hocuspocus 2.x
    // having `onAuthenticate` flips `requiresAuthentication = true`, which
    // rejects any client that doesn't send a `token` field — and our browser
    // clients identify by session cookie, not by an explicit token. The auth
    // check lives in `onConnect` instead, which still has access to
    // requestHeaders (so cookies + Bearer tokens both resolve), but is not
    // gated by the "must have token" handshake step.

    // Runs once per WebSocket connection — crucially ALSO when the Y.Doc is
    // already in memory, in which case `onLoadDocument` would be skipped and
    // an unauthenticated second connection would otherwise sync straight away.
    // DirectConnection (server-authored edits) bypasses this hook by design.
    async onConnect(payload: onConnectPayload) {
      const { canWrite } = await authorizeConnection(
        payload.requestHeaders,
        payload.documentName,
      );
      // A reader is CONNECTED, not refused. `readOnly` makes Hocuspocus drop
      // this client's SyncStep2 and Update messages (it acks them with a
      // false sync status) while still serving the document and its updates,
      // so a `viewer` watches the note change live and simply cannot type
      // into it. Refusing outright would have been the cheaper fix and the
      // worse product: the role means read-only, not "cannot look".
      //
      // Mutating `payload.connection` works because Hocuspocus hands the hook
      // the same object it later passes to the Connection constructor — the
      // spread in its `hooks()` call is shallow.
      if (!canWrite) payload.connection.readOnly = true;
    },

    async onLoadDocument(payload: onLoadDocumentPayload) {
      // Defence in depth: first connection to a cold doc runs both hooks.
      // Read access is what matters here — the write decision is carried by
      // the connection flag set in onConnect, and this hook has no connection.
      await authorizeConnection(payload.requestHeaders, payload.documentName);
      const noteId = parseDocName(payload.documentName)!;
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

    // ADR-004 — WHY THIS PATH STAYS PRIVILEGED. The REST and MCP data planes
    // run as `diluxite_app` with the caller's identity published, so Postgres
    // refuses cross-tenant rows even if a guard is missing. Collab does not,
    // for a reason rather than an oversight: a debounced store is the CRDT
    // merge of possibly several people's edits over ~2s, and there is no one
    // identity to publish. Inventing one would put a name on a write that
    // several people made.
    //
    // What protects it instead is `onConnect`, which authorises every
    // connection through the same `space-authz` door as REST and MCP and
    // marks a reader's connection read-only. That is one layer, not two —
    // recorded as such rather than implied.
    async onStoreDocument(payload: onStoreDocumentPayload) {
      const noteId = parseDocName(payload.documentName);
      if (!noteId) return;
      const state = Y.encodeStateAsUpdate(payload.document);
      const markdown = deriveMarkdown(payload.document);
      await deps.yjs.save(noteId, state);
      // Mirror to content_md so non-collab consumers (MCP, search, export)
      // see fresh text. Route through the repo rather than the service so
      // the indexer hook is fired here explicitly (Sprint 4 logic).
      // Attribution says `unknown`, and that is a finding rather than a
      // shortcut (ADR-002). A flush carries whatever was typed during the
      // ~2s debounce, which can be several people's edits merged by the CRDT.
      // Yjs knows per-client authorship inside the document; this hook does
      // not, and naming one of them here would be inventing provenance. What
      // IS known is the door: `collab`.
      const updated = await deps.notes.update(
        noteId,
        { contentMd: markdown },
        { agentKind: 'unknown', generatedBy: 'collab' },
      );
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
 *
 * RETURNS the markdown body actually observed/applied to the Y.Text — on the
 * LIVE path it's the live doc's text *after* the mutation (authoritative even
 * when content_md in the DB still lags the debounced flush), on the COLD path
 * it's the freshly derived markdown. Callers (e.g. PUT /api/notes/:id in
 * app.ts) should prefer this return value over re-reading content_md, which
 * may be stale while a live doc owns the note.
 */
export async function applyServerEdit(
  deps: CollabDeps,
  noteId: string,
  mutate: (text: Y.Text) => void,
  hocuspocus?: { documents: Map<string, { name: string }> } | null,
  // A server-authored edit DOES have a caller: the REST route, the MCP tool
  // or the restore that asked for it. Unlike a collab flush, that identity is
  // known and gets recorded — passing it is what separates "we could not tell"
  // from "nobody bothered".
  by?: WriteAttribution,
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
  // Persist through the repo directly (not NotesService) so we own the
  // indexing decision here. Reindex on the cold path too, otherwise a PUT /
  // MCP write to a note with no live collab doc would update content_md but
  // leave chunks / tags / embeddings stale — `save_memory` then
  // `search_memory` wouldn't find the new text.
  const updated = await deps.notes.update(noteId, { contentMd: markdown }, by);
  if (updated && deps.indexer) {
    await deps.indexer.index(updated);
  }
  doc.destroy();
  return markdown;
}

/**
 * Whole-body replace mutator for `applyServerEdit` — the path MCP
 * `write_note` and `PUT /api/notes/:id` take when collab is available.
 * Writing content_md straight to the DB would be silently overwritten by the
 * next `onStoreDocument` flush of a live Y.Doc; routing the replace through
 * the doc keeps both worlds consistent (and broadcasts to connected editors).
 */
export function replaceWholeText(text: Y.Text, content: string): void {
  if (text.length > 0) text.delete(0, text.length);
  if (content.length > 0) text.insert(0, content);
}
