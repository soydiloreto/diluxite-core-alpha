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
import type { Server as HocuspocusServer } from '@hocuspocus/server';

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
    const conn = await hServer.hocuspocus.openDirectConnection(noteDocName(noteId));
    let textInDoc = '';
    await conn.transact((doc) => {
      textInDoc = doc.getText(Y_TEXT_KEY).toString();
    });
    expect(textInDoc).toBe('arranca con texto');
    await conn.disconnect();
  });

  it('persists yjs_state + mirrors content_md when the doc is mutated', async () => {
    const conn = await hServer.hocuspocus.openDirectConnection(noteDocName(noteId));
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
    const conn1 = await hServer.hocuspocus.openDirectConnection(noteDocName(noteId));
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
    const conn2 = await hServer.hocuspocus.openDirectConnection(noteDocName(noteId));
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
});
