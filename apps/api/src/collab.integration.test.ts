import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import * as Y from 'yjs';
import { SingleUserAuthProvider, type AuthHeaders } from '@diluxite/core';
import {
  DrizzleNotesRepository,
  DrizzleNoteVersionsRepository,
  DrizzleSearchRepository,
  DrizzleSpacesRepository,
  DrizzleYjsStateRepository,
  createDb,
} from '@diluxite/db';
import { DeterministicEmbeddingProvider, SearchService } from '@diluxite/core';
import {
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
  DrizzleLinksRepository,
  DrizzleOrganizationsRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { NotesService } from '@diluxite/core';
import { buildTestApp } from '../test/helpers';
import { buildApp, type AppDeps } from './app';
import { buildCollabServer, Y_TEXT_KEY, applyServerEdit, noteDocName, replaceWholeText } from './collab';
import type { Hocuspocus as HocuspocusServer } from '@hocuspocus/server';
import type { NotesRepository, YjsStateRepository } from '@diluxite/core';

/** Build a full app wired with a collab bridge pointed at a live Hocuspocus. */
async function buildAppWithCollab(
  userId: string,
  collab: {
    notesRepo: NotesRepository;
    yjs: YjsStateRepository;
    hocuspocus: HocuspocusServer;
  },
): Promise<FastifyInstance> {
  const conn = createDb(TEST_URL);
  const { db } = conn;
  const notesRepo = new DrizzleNotesRepository(db);
  const search = new SearchService(
    new DrizzleSearchRepository(db),
    new DeterministicEmbeddingProvider(64),
    notesRepo,
  );
  const deps: AppDeps = {
    notes: new NotesService(notesRepo, search),
    search,
    spaces: new DrizzleSpacesRepository(db),
    organizations: new DrizzleOrganizationsRepository(db),
    users: new DrizzleUsersRepository(db),
    tokens: new DrizzleTokensRepository(db),
    tags: new DrizzleTagsRepository(db),
    links: new DrizzleLinksRepository(db),
    folders: new DrizzleFoldersRepository(db),
    move: new DrizzleMoveRepository(db),
    auth: new SingleUserAuthProvider(userId),
    collab: {
      notesRepo: collab.notesRepo,
      yjs: collab.yjs,
      hocuspocus: collab.hocuspocus as unknown as { documents: Map<string, { name: string }> },
    },
  };
  const app = await buildApp(deps);
  await app.ready();
  return app;
}

/**
 * Integration tests for collaborative editing — Sprint 1.
 *
 * Real Hocuspocus server + real Postgres. The transport is `openDirectConnection`
 * (in-process), which exercises all of the same hooks (onLoadDocument,
 * onStoreDocument) the WebSocket clients hit but skips the `crossws` + `ws`
 * round-trip that needs a browser to fully validate. The WebSocket transport
 * itself is covered in Sprint 2 when the CodeMirror client lands and we run
 * Playwright across two browser contexts.
 *
 * What we *do* prove here:
 *   - Hydration from content_md on first open works (seedDocFromMarkdown path).
 *   - Server-side edits via DirectConnection are persisted (yjs_state +
 *     content_md derivation in onStoreDocument).
 *   - Reopening the same document hydrates from the stored yjs_state, not
 *     a fresh seed from a stale content_md.
 *   - applyServerEdit (MCP write-path) reaches Postgres with both columns.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('collab integration: Hocuspocus hooks + Postgres', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let userId: string;
  let hServer: HocuspocusServer;
  let noteId: string;
  let collabDb: ReturnType<typeof createDb>;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;

    const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    userId = rows[0]?.id ?? '';
    expect(userId).toBeTruthy();

    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Collab Test', contentMd: 'arranca con texto' },
    });
    expect(r.statusCode).toBe(201);
    noteId = r.json().id as string;

    collabDb = createDb(TEST_URL);
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const spacesRepo = new DrizzleSpacesRepository(collabDb.db);
    const orgsRepo = new DrizzleOrganizationsRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);
    hServer = buildCollabServer({ auth, notes: notesRepo, yjs: yjsRepo, spaces: spacesRepo, organizations: orgsRepo });
  });

  afterEach(async () => {
    await hServer.destroy();
    await collabDb.sql.end();
    await app.close();
    await sql.end();
  });

  it('hydrates a fresh Y.Doc from content_md on first open', async () => {
    const conn = await hServer.openDirectConnection(noteDocName(noteId));
    let textInDoc = '';
    await conn.transact((doc) => {
      textInDoc = doc.getText(Y_TEXT_KEY).toString();
    });
    expect(textInDoc).toBe('arranca con texto');
    await conn.disconnect();
  });

  it('persists yjs_state + mirrors content_md when the doc is mutated', async () => {
    const conn = await hServer.openDirectConnection(noteDocName(noteId));
    await conn.transact((doc) => {
      const t = doc.getText(Y_TEXT_KEY);
      t.insert(t.length, ' + edit-1');
    });

    // Disconnecting flushes the debounced onStoreDocument hook.
    await conn.disconnect();

    await waitFor(async () => {
      const rows =
        await sql`SELECT content_md FROM notes WHERE id = ${noteId}`;
      return rows[0]?.content_md === 'arranca con texto + edit-1';
    }, 10000);

    const rows = await sql`SELECT content_md, yjs_state FROM notes WHERE id = ${noteId}`;
    expect(rows[0].content_md).toBe('arranca con texto + edit-1');
    expect(rows[0].yjs_state).toBeTruthy();
    expect((rows[0].yjs_state as Buffer).byteLength).toBeGreaterThan(0);
  });

  it('reopening hydrates from yjs_state (NOT a re-seed from content_md)', async () => {
    // Round 1: edit + flush.
    const conn1 = await hServer.openDirectConnection(noteDocName(noteId));
    await conn1.transact((doc) => {
      doc.getText(Y_TEXT_KEY).insert(doc.getText(Y_TEXT_KEY).length, ' v1');
    });
    await conn1.disconnect();
    await waitFor(async () => {
      const rows = await sql`SELECT yjs_state FROM notes WHERE id = ${noteId}`;
      return rows[0]?.yjs_state != null;
    }, 5000);

    // Hostile out-of-band mutation of content_md. If our pipeline incorrectly
    // re-seeds from content_md on re-open, this poison string would surface
    // in the doc. The yjs_state should win.
    await sql`UPDATE notes SET content_md = 'POISON' WHERE id = ${noteId}`;

    // Round 2: re-open. Expect 'arranca con texto v1', not 'POISON'.
    const conn2 = await hServer.openDirectConnection(noteDocName(noteId));
    let observed = '';
    await conn2.transact((doc) => {
      observed = doc.getText(Y_TEXT_KEY).toString();
      doc.getText(Y_TEXT_KEY).insert(doc.getText(Y_TEXT_KEY).length, ' v2');
    });
    expect(observed).toBe('arranca con texto v1');
    await conn2.disconnect();

    // After the next flush, content_md is re-derived from the doc and the
    // poison string is overwritten.
    await waitFor(async () => {
      const rows = await sql`SELECT content_md FROM notes WHERE id = ${noteId}`;
      return rows[0]?.content_md === 'arranca con texto v1 v2';
    }, 5000);
  });

  it('applyServerEdit (server-side write) is reflected in persistence', async () => {
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);

    await applyServerEdit(
      { auth, notes: notesRepo, yjs: yjsRepo },
      noteId,
      (text) => text.insert(text.length, ' [from server]'),
    );

    const rows = await sql`SELECT content_md, yjs_state FROM notes WHERE id = ${noteId}`;
    expect(rows[0].content_md).toContain('[from server]');
    expect(rows[0].yjs_state).toBeTruthy();
  });

  it('a server-side whole-body replace (the restore path) records history at the repo door', async () => {
    // The live bug this guards against: restore wrote content_md directly,
    // the live Y.Doc never heard about it, and the next flush reverted it —
    // and separately, a snapshot hook at the service level missed this path
    // entirely. Both fixes meet here: the replace goes through
    // applyServerEdit, and the repository's own `update` records history.
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const versions = new DrizzleNoteVersionsRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);

    await applyServerEdit(
      { auth, notes: notesRepo, yjs: yjsRepo },
      noteId,
      (text) => replaceWholeText(text, 'texto restaurado desde una versión'),
    );

    const rows = await sql`SELECT content_md FROM notes WHERE id = ${noteId}`;
    expect(rows[0].content_md).toBe('texto restaurado desde una versión');
    const history = await versions.listForNote(noteId);
    expect(history.length).toBeGreaterThan(0); // the replaced state was snapshotted
  });

  it('applyServerEdit COLD path reindexes → new text is searchable (Fix 1)', async () => {
    // The MCP / PUT write path with no live doc. Before the fix this updated
    // content_md but left chunks stale, so `save_memory` then `search_memory`
    // wouldn't find the new text. With `indexer` wired in, the cold path
    // reindexes and keyword search finds the unique token.
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const searchRepo = new DrizzleSearchRepository(collabDb.db);
    const embedder = new DeterministicEmbeddingProvider(64);
    const indexer = new SearchService(searchRepo, embedder, notesRepo);
    const auth = new SingleUserAuthProvider(userId);

    const token = 'flubberwocky';
    await applyServerEdit(
      { auth, notes: notesRepo, yjs: yjsRepo, indexer },
      noteId,
      (text) => text.insert(text.length, ` ${token}`),
    );

    const hits = await indexer.search(spaceId, token, 5, 'keyword');
    expect(hits.some((h) => h.noteId === noteId)).toBe(true);
  });

  it('LIVE doc onStoreDocument flush reindexes → new text is searchable (Fix 1)', async () => {
    // With the indexer wired into buildCollabServer, the debounced
    // onStoreDocument tick (fired on disconnect) reindexes the live doc.
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const spacesRepo = new DrizzleSpacesRepository(collabDb.db);
    const orgsRepo = new DrizzleOrganizationsRepository(collabDb.db);
    const searchRepo = new DrizzleSearchRepository(collabDb.db);
    const embedder = new DeterministicEmbeddingProvider(64);
    const indexer = new SearchService(searchRepo, embedder, notesRepo);
    const auth = new SingleUserAuthProvider(userId);

    const indexedServer = buildCollabServer({
      auth,
      notes: notesRepo,
      yjs: yjsRepo,
      spaces: spacesRepo, organizations: orgsRepo,
      indexer,
    });
    try {
      const token = 'wibblesnork';
      const conn = await indexedServer.openDirectConnection(noteDocName(noteId));
      await conn.transact((doc) => {
        const t = doc.getText(Y_TEXT_KEY);
        t.insert(t.length, ` ${token}`);
      });
      // Disconnecting flushes the debounced onStoreDocument hook → reindex.
      await conn.disconnect();

      await waitFor(async () => {
        const hits = await indexer.search(spaceId, token, 5, 'keyword');
        return hits.some((h) => h.noteId === noteId);
      }, 10000);
    } finally {
      await indexedServer.destroy();
    }
  });

  it('PUT /api/notes/:id returns the markdown applyServerEdit applied, not a stale re-read (#11c)', async () => {
    // Build an app wired with the live collab server, then drive a PUT through
    // it. With a live doc owning the note, content_md in the DB lags the
    // debounced flush — the PUT response must carry the markdown the helper
    // applied (authoritative), not the stale DB column.
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);

    const collabApp = await buildAppWithCollab(userId, {
      notesRepo,
      yjs: yjsRepo,
      hocuspocus: hServer,
    });
    try {
      // Open a LIVE doc so the PUT takes the DirectConnection path.
      const conn = await hServer.openDirectConnection(noteDocName(noteId));

      const r = await collabApp.inject({
        method: 'PUT',
        url: `/api/notes/${noteId}`,
        payload: { contentMd: 'fresh live body' },
      });
      expect(r.statusCode).toBe(200);
      // The response reflects the just-applied text immediately.
      expect(r.json().contentMd).toBe('fresh live body');

      await conn.disconnect();
    } finally {
      await collabApp.close();
    }
  });

  it('REAL WebSocket sync: a Node client receives initial state via /collab', async () => {
    // This is the regression check for the alpha.11 production bug — Hocuspocus
    // 4.x with crossws accepted WS upgrades but never sent the initial sync,
    // leaving every browser client with an empty editor. 2.x uses ws directly
    // and the sync flows.
    const [{ HocuspocusProvider, HocuspocusProviderWebsocket }, WS] = await Promise.all([
      import('@hocuspocus/provider'),
      import('ws').then((m) => m.default),
    ]);
    // Listen on a known port (port 0 didn't override in Hocuspocus 4; this is
    // 2.x which honours the listen arg directly, but we still want a free
    // port to avoid collisions with the project's docker-compose db).
    const TEST_WS_PORT = 39131;
    await hServer.listen(TEST_WS_PORT);
    try {
      const docName = noteDocName(noteId);
      const wsConn = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${TEST_WS_PORT}`,
        WebSocketPolyfill: WS as never,
      });
      const Y = await import('yjs');
      const doc = new Y.Doc();
      const events: string[] = [];
      const prov = new HocuspocusProvider({
        websocketProvider: wsConn,
        name: docName,
        document: doc,
        onSynced: () => events.push('synced'),
        onStatus: (e: { status: string }) => events.push(`status:${e.status}`),
      });
      // Wait until the seeded markdown reaches the client's Y.Text. The
      // server hydrates from content_md ("arranca con texto") in onLoadDocument.
      await waitFor(
        () => doc.getText(Y_TEXT_KEY).toString() === 'arranca con texto',
        8000,
      );
      expect(events).toContain('synced');
      prov.destroy();
      wsConn.destroy();
    } finally {
      // afterEach destroys hServer which closes the listen socket.
    }
  });

  it('applyServerEdit goes through the LIVE doc when one is loaded', async () => {
    // Sprint 4 — the MCP write path. Open a connection so the doc is "live"
    // in Hocuspocus, then have the server author an edit. The edit must hit
    // the same Y.Doc the connection observes (which is what would broadcast
    // to a real client).
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);

    const conn = await hServer.openDirectConnection(noteDocName(noteId));
    // Verify doc is hot.
    expect(hServer.documents.has(noteDocName(noteId))).toBe(true);

    // Server-side edit must take the LIVE path.
    await applyServerEdit(
      { auth, notes: notesRepo, yjs: yjsRepo },
      noteId,
      (text) => text.insert(text.length, ' [live append]'),
      hServer as unknown as { documents: Map<string, { name: string }>; openDirectConnection: typeof hServer.openDirectConnection },
    );

    // The connection's view of the doc reflects the server-authored edit.
    let observed = '';
    await conn.transact((doc) => {
      observed = doc.getText(Y_TEXT_KEY).toString();
    });
    expect(observed).toBe('arranca con texto [live append]');

    await conn.disconnect();
  });
});

/**
 * ─── Capa 3 — REAL WebSocket transport ────────────────────────────────────
 *
 * These exercise the path that broke in alpha.11: real HocuspocusProvider
 * clients (over `ws://`), full sync protocol, full awareness protocol,
 * applyServerEdit broadcast. Anything that uses `openDirectConnection` does
 * NOT belong in this block because the in-process channel bypasses crossws /
 * ws / sync messages entirely.
 *
 * If any of these break, real browsers also broke. That's the contract.
 */
describe('collab integration: REAL WebSocket transport', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let userId: string;
  let hServer: HocuspocusServer;
  let port: number;
  let noteId: string;
  let collabDb: ReturnType<typeof createDb>;

  // We use a different port per test to avoid TIME_WAIT races between tests.
  let nextPort = 39200;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;

    const rows = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
    userId = rows[0]?.id ?? '';
    expect(userId).toBeTruthy();

    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'WS Test', contentMd: 'inicial' },
    });
    expect(r.statusCode).toBe(201);
    noteId = r.json().id as string;

    collabDb = createDb(TEST_URL);
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const spacesRepo = new DrizzleSpacesRepository(collabDb.db);
    const orgsRepo = new DrizzleOrganizationsRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);
    hServer = buildCollabServer({ auth, notes: notesRepo, yjs: yjsRepo, spaces: spacesRepo, organizations: orgsRepo });
    port = nextPort++;
    await hServer.listen(port);
  });

  afterEach(async () => {
    // Order matters: kill the WS server first so live connections terminate
    // before we close the postgres pools they may still be writing to.
    // Without this, Hocuspocus' debounced onStoreDocument fires after
    // `collabDb.sql.end()` and we get spurious CONNECTION_ENDED errors in
    // the test report.
    await hServer.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await collabDb.sql.end();
    await app.close();
    await sql.end();
  });

  // Tiny helper that spawns a Hocuspocus client provider + Y.Doc on top of
  // node-ws. Returns the doc + the cleanup. We keep this inline rather than
  // promote to a shared helper because it's the only place we need it.
  async function spawnClient(): Promise<{
    doc: Y.Doc;
    prov: import('@hocuspocus/provider').HocuspocusProvider;
    ws: import('@hocuspocus/provider').HocuspocusProviderWebsocket;
    destroy: () => void;
  }> {
    const [{ HocuspocusProvider, HocuspocusProviderWebsocket }, WS] =
      await Promise.all([
        import('@hocuspocus/provider'),
        import('ws').then((m) => m.default),
      ]);
    const ws = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`,
      WebSocketPolyfill: WS as never,
    });
    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({
      websocketProvider: ws,
      name: noteDocName(noteId),
      document: doc,
    });
    return {
      doc,
      prov,
      ws,
      destroy: () => {
        prov.destroy();
        ws.destroy();
      },
    };
  }

  it('two real clients see each others edits via WS sync', async () => {
    // Regression for "the alpha.11 bug": two HocuspocusProvider instances
    // connect to /collab; client A types, client B observes it through the
    // real wire (not DirectConnection).
    const a = await spawnClient();
    const b = await spawnClient();

    // Both clients first observe the seeded text.
    await waitFor(() => a.doc.getText(Y_TEXT_KEY).toString() === 'inicial', 6000);
    await waitFor(() => b.doc.getText(Y_TEXT_KEY).toString() === 'inicial', 6000);

    // A types — append marker so we don't accidentally match the seed.
    a.doc.getText(Y_TEXT_KEY).insert('inicial'.length, ' + A typed');

    // B observes the edit through the WS sync protocol.
    await waitFor(
      () => b.doc.getText(Y_TEXT_KEY).toString() === 'inicial + A typed',
      6000,
    );
    expect(b.doc.getText(Y_TEXT_KEY).toString()).toBe('inicial + A typed');

    a.destroy();
    b.destroy();
  });

  it('awareness state propagates between two real WS clients (cursors/users)', async () => {
    // Drives the PresenceAvatars + remote cursor rendering. Each client
    // publishes a `user` field; the other client must see it via the
    // awareness protocol over the same WS connection.
    const a = await spawnClient();
    const b = await spawnClient();

    // Wait for both to be synced before publishing awareness (otherwise the
    // server can drop the awareness update before it's wired up).
    await waitFor(() => a.doc.getText(Y_TEXT_KEY).toString() === 'inicial', 6000);
    await waitFor(() => b.doc.getText(Y_TEXT_KEY).toString() === 'inicial', 6000);

    a.prov.awareness?.setLocalStateField('user', {
      identity: 'a@x',
      name: 'Alice',
      color: 'hsl(120, 65%, 50%)',
    });
    b.prov.awareness?.setLocalStateField('user', {
      identity: 'b@x',
      name: 'Bob',
      color: 'hsl(240, 65%, 50%)',
    });

    // A should see Bob in its roster (and vice-versa). We check the
    // remote state via awareness.getStates which returns ALL clients
    // including self.
    await waitFor(() => {
      const states = Array.from(a.prov.awareness?.getStates().values() ?? []);
      return states.some(
        (s) => (s as { user?: { name?: string } }).user?.name === 'Bob',
      );
    }, 6000);

    await waitFor(() => {
      const states = Array.from(b.prov.awareness?.getStates().values() ?? []);
      return states.some(
        (s) => (s as { user?: { name?: string } }).user?.name === 'Alice',
      );
    }, 6000);

    a.destroy();
    b.destroy();
  });

  it('a real WS client receives an applyServerEdit broadcast in real time', async () => {
    // The MCP write path: server authors an edit via applyServerEdit while
    // a real client is connected. Client must see it without re-syncing.
    const a = await spawnClient();
    await waitFor(() => a.doc.getText(Y_TEXT_KEY).toString() === 'inicial', 6000);

    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const auth = new SingleUserAuthProvider(userId);
    await applyServerEdit(
      { auth, notes: notesRepo, yjs: yjsRepo },
      noteId,
      (text) => text.insert(text.length, ' [server-write]'),
      hServer as unknown as {
        documents: Map<string, { name: string }>;
        openDirectConnection: typeof hServer.openDirectConnection;
      },
    );

    await waitFor(
      () => a.doc.getText(Y_TEXT_KEY).toString() === 'inicial [server-write]',
      6000,
    );
    expect(a.doc.getText(Y_TEXT_KEY).toString()).toBe('inicial [server-write]');

    a.destroy();
  });
});

/**
 * ─── Per-space authorization on WS connections (RS-2) ─────────────────────
 *
 * Two regressions covered here:
 *   1. Membership: any authenticated user could open ANY note's doc — the
 *      hooks resolved identity but never checked space membership.
 *   2. Hot-doc bypass: in Hocuspocus 2.x `onLoadDocument` only fires when the
 *      doc is cold. A second, unauthenticated connection to an in-memory doc
 *      synced without ever hitting an auth check. `onConnect` (per
 *      connection) closes that hole.
 *
 * The auth provider here resolves identity from an `x-test-user` header so
 * each WS connection can impersonate a different user (or none) — the
 * SingleUserAuthProvider used elsewhere would make everyone look valid.
 */
describe('collab integration: connection authorization (RS-2)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let spaceId: string;
  let userId: string;
  let strangerId: string;
  let hServer: HocuspocusServer;
  let port: number;
  let noteId: string;
  let collabDb: ReturnType<typeof createDb>;

  let nextPort = 39300;

  beforeEach(async () => {
    const t = await buildTestApp();
    app = t.app;
    sql = t.sql;
    spaceId = t.defaultSpaceId;
    userId = t.userId;

    const r = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/notes`,
      payload: { title: 'Authz Test', contentMd: 'contenido privado' },
    });
    expect(r.statusCode).toBe(201);
    noteId = r.json().id as string;

    // A second tenant: user + org + space the note's owner has nothing to do
    // with. The stranger is authenticated but NOT a member of `spaceId`.
    const [stranger] = await sql<{ id: string }[]>`
      INSERT INTO users (email, provider) VALUES ('intruder@other.org', 'local') RETURNING id`;
    strangerId = stranger.id;
    // Unique slug: buildTestApp truncates users/spaces/notes but NOT
    // organizations, so a fixed slug would collide on the second test.
    const slug = `other-org-authz-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const [otherOrg] = await sql<{ id: string }[]>`
      INSERT INTO organizations (name, slug) VALUES ('Other Org', ${slug}) RETURNING id`;
    await sql`
      INSERT INTO spaces (name, owner_id, org_id) VALUES ('Other Space', ${strangerId}, ${otherOrg.id})`;

    collabDb = createDb(TEST_URL);
    const notesRepo = new DrizzleNotesRepository(collabDb.db);
    const yjsRepo = new DrizzleYjsStateRepository(collabDb.db);
    const spacesRepo = new DrizzleSpacesRepository(collabDb.db);
    const orgsRepo = new DrizzleOrganizationsRepository(collabDb.db);
    // Header-driven identity: `x-test-user: <uuid>` → that user; absent → null.
    const auth = {
      async resolve(headers: AuthHeaders) {
        const raw = headers['x-test-user'];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return value ? { kind: 'user' as const, userId: value } : null;
      },
    };
    hServer = buildCollabServer({ auth, notes: notesRepo, yjs: yjsRepo, spaces: spacesRepo, organizations: orgsRepo });
    port = nextPort++;
    await hServer.listen(port);
  });

  afterEach(async () => {
    await hServer.destroy();
    await new Promise((r) => setTimeout(r, 50));
    await collabDb.sql.end();
    await app.close();
    await sql.end();
  });

  // Like spawnClient above, but with custom upgrade-request headers — that's
  // how a browser's session cookie travels, and how our fake header auth
  // chooses an identity per connection.
  async function spawnClientAs(headers: Record<string, string>): Promise<{
    doc: Y.Doc;
    closes: number[];
    destroy: () => void;
  }> {
    const [{ HocuspocusProvider, HocuspocusProviderWebsocket }, WSBase] = await Promise.all([
      import('@hocuspocus/provider'),
      import('ws').then((m) => m.default),
    ]);
    class HeaderWS extends WSBase {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers });
      }
    }
    const ws = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}`,
      WebSocketPolyfill: HeaderWS as never,
    });
    const closes: number[] = [];
    ws.on('close', ({ event }: { event: { code: number } }) => closes.push(event.code));
    const doc = new Y.Doc();
    const prov = new HocuspocusProvider({
      websocketProvider: ws,
      name: noteDocName(noteId),
      document: doc,
    });
    return {
      doc,
      closes,
      destroy: () => {
        prov.destroy();
        ws.destroy();
      },
    };
  }

  it('a member of the space connects and syncs (sanity)', async () => {
    const member = await spawnClientAs({ 'x-test-user': userId });
    await waitFor(() => member.doc.getText(Y_TEXT_KEY).toString() === 'contenido privado', 6000);
    member.destroy();
  });

  it('an authenticated user from ANOTHER org/space is rejected (4403, never syncs)', async () => {
    const intruder = await spawnClientAs({ 'x-test-user': strangerId });
    // Hocuspocus closes with Forbidden (4403) when onConnect throws.
    await waitFor(() => intruder.closes.length > 0, 6000);
    expect(intruder.closes[0]).toBe(4403);
    // Give a sync a chance to (wrongly) land before asserting it didn't.
    await new Promise((r) => setTimeout(r, 200));
    expect(intruder.doc.getText(Y_TEXT_KEY).toString()).toBe('');
    intruder.destroy();
  });

  it('a second UNAUTHENTICATED connection to an already-loaded doc is rejected', async () => {
    // First connection (authorized) loads the doc into memory…
    const member = await spawnClientAs({ 'x-test-user': userId });
    await waitFor(() => member.doc.getText(Y_TEXT_KEY).toString() === 'contenido privado', 6000);

    // …so `onLoadDocument` will NOT fire for the next connection. Before the
    // `onConnect` hook existed this anonymous client synced the full doc.
    const anon = await spawnClientAs({});
    await waitFor(() => anon.closes.length > 0, 6000);
    expect(anon.closes[0]).toBe(4403);
    await new Promise((r) => setTimeout(r, 200));
    expect(anon.doc.getText(Y_TEXT_KEY).toString()).toBe('');

    anon.destroy();
    member.destroy();
  });
});
