import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import * as Y from 'yjs';
import { SingleUserAuthProvider } from '@diluxite/core';
import {
  DrizzleNotesRepository,
  DrizzleYjsStateRepository,
  createDb,
} from '@diluxite/db';
import { buildTestApp } from '../test/helpers';
import { buildCollabServer, Y_TEXT_KEY, applyServerEdit, noteDocName } from './collab';
import type { Hocuspocus as HocuspocusServer } from '@hocuspocus/server';

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
    const auth = new SingleUserAuthProvider(userId);
    hServer = buildCollabServer({ auth, notes: notesRepo, yjs: yjsRepo });
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
    const auth = new SingleUserAuthProvider(userId);
    hServer = buildCollabServer({ auth, notes: notesRepo, yjs: yjsRepo });
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
