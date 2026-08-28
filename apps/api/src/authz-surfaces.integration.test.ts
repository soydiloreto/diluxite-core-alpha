import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import type { AddressInfo } from 'node:net';
import {
  DeterministicEmbeddingProvider,
  NotesService,
  SearchService,
  SessionAuthProvider,
} from '@diluxite/core';
import {
  createDb,
  DrizzleFoldersRepository,
  DrizzleMoveRepository,
  DrizzleLinksRepository,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzleSearchRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
  DrizzleYjsStateRepository,
} from '@diluxite/db';
import { buildApp, type AppDeps } from './app';
import { buildCollabServer, noteDocName, Y_TEXT_KEY } from './collab';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * The workspace role has to mean the same thing on EVERY surface.
 *
 * It did not. REST enforced it; MCP checked bare membership, so a `viewer`
 * could create, edit and delete notes through an agent while the same account
 * got a 403 from the web app; and the collab WebSocket checked bare membership
 * too AND never looked at org-token scopes, so a read-only token could have
 * typed into a live document. Three surfaces, three answers, because the rule
 * was a closure inside `buildApp` that the other two could not reach.
 *
 * These tests are per-surface on purpose. `space-authz.test.ts` pins the rule
 * itself; this file pins that each door actually calls it — which is the half
 * that was broken, and the half a unit test cannot see.
 */

async function waitFor(cond: () => boolean, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('workspace role is enforced on every surface', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let conn: ReturnType<typeof createDb>;
  let port: number;

  let tokensRepo: DrizzleTokensRepository;
  let spaceId: string;
  let orgId: string;
  let noteId: string;
  let viewerToken: string;
  let editorToken: string;

  beforeEach(async () => {
    const clean = createDb(TEST_DATABASE_URL);
    await clean.sql`TRUNCATE audit_events, sessions, chunks, notes, memberships, spaces, org_memberships, org_settings, organizations, users RESTART IDENTITY CASCADE`;
    await clean.sql.end();

    conn = createDb(TEST_DATABASE_URL);
    sql = conn.sql;
    const users = new DrizzleUsersRepository(conn.db);
    const spaces = new DrizzleSpacesRepository(conn.db);
    const orgs = new DrizzleOrganizationsRepository(conn.db);
    tokensRepo = new DrizzleTokensRepository(conn.db);

    const adminId = (await users.create('admin@diluxite')).id;
    const viewerId = (await users.create('viewer@diluxite')).id;
    const editorId = (await users.create('editor@diluxite')).id;

    orgId = (await orgs.create('Acme', `acme-${Date.now()}`, adminId)).id;
    // Plain org members: nothing here may come from the org-admin escalation.
    await orgs.addOrUpdateMember(orgId, viewerId, 'member');
    await orgs.addOrUpdateMember(orgId, editorId, 'member');

    spaceId = (await spaces.create(orgId, 'Space', adminId)).id;
    await spaces.addOrUpdateMember(spaceId, viewerId, 'viewer');
    await spaces.addOrUpdateMember(spaceId, editorId, 'editor');

    const notesRepo = new DrizzleNotesRepository(conn.db);
    const search = new SearchService(
      new DrizzleSearchRepository(conn.db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    const seeded = await notes.create({ spaceId, title: 'Azure', contentMd: '' });
    noteId = seeded.id;
    await notes.update(noteId, { contentMd: 'Azure is the Microsoft cloud' });

    viewerToken = (await tokensRepo.create(viewerId, 'viewer-agent', null)).token;
    editorToken = (await tokensRepo.create(editorId, 'editor-agent', null)).token;

    const deps: AppDeps = {
      notes,
      search,
      spaces,
      organizations: orgs,
      users,
      tokens: tokensRepo,
      sessions: new DrizzleSessionsRepository(conn.db),
      tags: new DrizzleTagsRepository(conn.db),
      links: new DrizzleLinksRepository(conn.db),
      folders: new DrizzleFoldersRepository(conn.db),
      move: new DrizzleMoveRepository(conn.db),
      auth: new SessionAuthProvider(new DrizzleSessionsRepository(conn.db), tokensRepo),
      info: { embedder: 'local', version: '0.0.0', authMode: 'server' },
    };
    app = await buildApp(deps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    await sql.end();
  });

  // ── MCP ────────────────────────────────────────────────────────────────

  async function mcpPost(body: unknown, token: string, sid?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sid ? { 'mcp-session-id': sid } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function initSession(token: string): Promise<string> {
    const res = await mcpPost(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'raw', version: '0.0.0' },
        },
      },
      token,
    );
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id')!;
    await res.body?.cancel();
    return sid;
  }

  async function callToolText(
    token: string,
    sid: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const res = await mcpPost(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
      token,
      sid,
    );
    const raw = await res.text();
    const dataLine = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    const json = JSON.parse((dataLine ?? raw).replace(/^data:\s*/, ''));
    return (json.result?.content ?? []).map((c: { text: string }) => c.text).join('\n');
  }

  it('MCP: a viewer READS', async () => {
    const sid = await initSession(viewerToken);
    expect(await callToolText(viewerToken, sid, 'search_memory', { query: 'microsoft cloud' }))
      .toContain('Azure');
    expect(await callToolText(viewerToken, sid, 'read_note', { id: noteId })).toContain('Azure');
  });

  it('MCP: a viewer cannot write_note — the bug this file exists for', async () => {
    const sid = await initSession(viewerToken);
    const out = await callToolText(viewerToken, sid, 'write_note', {
      title: 'Colada',
      content: 'no debería entrar',
    });
    expect(out).toMatch(/read-only|no space you can write to/i);

    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from notes where title = 'Colada'`;
    expect(count).toBe('0');
  });

  it('MCP: a viewer cannot append_to_note or delete_note', async () => {
    const sid = await initSession(viewerToken);

    const appended = await callToolText(viewerToken, sid, 'append_to_note', {
      id: noteId,
      content: 'línea colada',
    });
    expect(appended).toMatch(/read-only|not found|no space you can write to/i);

    const deleted = await callToolText(viewerToken, sid, 'delete_note', { id: noteId });
    expect(deleted).toMatch(/read-only|not found|no space you can write to/i);

    const [row] = await sql<{ content_md: string; deleted_at: string | null }[]>`
      select content_md, deleted_at from notes where id = ${noteId}`;
    expect(row.content_md).not.toContain('línea colada');
    expect(row.deleted_at).toBeNull();
  });

  it('MCP: an editor in the same space CAN write (the control)', async () => {
    const sid = await initSession(editorToken);
    const out = await callToolText(editorToken, sid, 'write_note', {
      title: 'Legítima',
      content: 'entra',
    });
    expect(out).not.toMatch(/read-only|no space you can write to/i);

    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from notes where title = 'Legítima'`;
    expect(count).toBe('1');
  });

  // ── REST (the surface that was already right — kept as the reference) ───

  it('REST: viewer is refused the write and allowed the read', async () => {
    const write = await app.inject({
      method: 'PUT',
      url: `/api/notes/${noteId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { contentMd: 'colada' },
    });
    expect(write.statusCode).toBe(403);

    const read = await app.inject({
      method: 'GET',
      url: `/api/notes/${noteId}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(read.statusCode).toBe(200);
  });

  // ── Collab WebSocket ───────────────────────────────────────────────────

  /**
   * Connect as `token`, type `text` at the head of the document, and report
   * whether the server kept it.
   *
   * The wait is deliberately longer than Hocuspocus' ~2s onStoreDocument
   * debounce, and that detail is the whole test: an earlier version waited
   * 1.5s, so "the viewer's text was not persisted" was true because NOTHING
   * had been persisted yet. It passed with the fix reverted. The editor case
   * below is the control that proves the window is actually long enough.
   */
  async function typeOverWebSocket(
    token: string,
    text: string,
  ): Promise<{ persisted: string; contentMd: string }> {
    const notesRepo = new DrizzleNotesRepository(conn.db);
    const yjsRepo = new DrizzleYjsStateRepository(conn.db);
    const hServer = buildCollabServer({
      auth: new SessionAuthProvider(new DrizzleSessionsRepository(conn.db), tokensRepo),
      notes: notesRepo,
      yjs: yjsRepo,
      spaces: new DrizzleSpacesRepository(conn.db),
      organizations: new DrizzleOrganizationsRepository(conn.db),
    });
    // Port 0: the OS assigns a free one and `address` reports it back. Fixed
    // or random ports collide — first with each other, then with the counters
    // in `collab.integration.test.ts` — and the sockets do not always come
    // back before the next file asks for one. Letting the OS decide removes
    // the class instead of spacing the numbers further apart.
    await hServer.listen(0);
    const wsPort = hServer.address.port;

    const [{ HocuspocusProvider, HocuspocusProviderWebsocket }, WSBase, Y] = await Promise.all([
      import('@hocuspocus/provider'),
      import('ws').then((m) => m.default),
      import('yjs'),
    ]);

    // Identity travels on the UPGRADE REQUEST, exactly as a browser's session
    // cookie does — the provider's own `token` option is a Yjs-level message
    // the AuthProvider never sees.
    class HeaderWS extends WSBase {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { authorization: `Bearer ${token}` } });
      }
    }

    try {
      const ws = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${wsPort}`,
        WebSocketPolyfill: HeaderWS as never,
      });
      const doc = new Y.Doc();
      const prov = new HocuspocusProvider({
        websocketProvider: ws,
        name: noteDocName(noteId),
        document: doc,
      });

      // Reaching this at all is half the assertion for the viewer: read-only
      // is a CONNECTED state, not a refusal.
      await waitFor(() => doc.getText(Y_TEXT_KEY).toString().includes('Azure'), 8000);

      doc.getText(Y_TEXT_KEY).insert(0, text);
      await new Promise((r) => setTimeout(r, 4000));

      const stored = await yjsRepo.load(noteId);
      const serverDoc = new Y.Doc();
      if (stored && stored.byteLength > 0) Y.applyUpdate(serverDoc, stored);
      const [row] = await sql<{ content_md: string }[]>`
        select content_md from notes where id = ${noteId}`;

      prov.destroy();
      ws.destroy();
      return { persisted: serverDoc.getText(Y_TEXT_KEY).toString(), contentMd: row.content_md };
    } finally {
      // `destroy()` resolves before its final onStoreDocument has finished
      // writing, and `afterEach` closes the postgres pool right after — on a
      // slower CI runner that store landed after `sql.end()` and surfaced as
      // CONNECTION_ENDED. The settle is generous on purpose: this runs four
      // times in the file and half a second of teardown is cheaper than a
      // suite people learn to re-run.
      await hServer.destroy();
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  it('collab: an editor connects and their typing IS persisted (the control)', async () => {
    const { persisted, contentMd } = await typeOverWebSocket(editorToken, 'LEGITIMO ');
    expect(persisted).toContain('LEGITIMO');
    expect(contentMd).toContain('LEGITIMO');
  });

  it('collab: a viewer connects and syncs, but their typing is DROPPED', async () => {
    const { persisted, contentMd } = await typeOverWebSocket(viewerToken, 'COLADO ');
    expect(persisted).not.toContain('COLADO');
    expect(contentMd).not.toContain('COLADO');
  });

  // The other half of the collab bug: the org branch of the old check called
  // `isSpaceInOrg` and NOTHING else, so a token minted read-only — the safe
  // default — could still have typed into a live document. REST refused the
  // same token on the same note. Scopes now decide here too.
  it('collab: a read-only ORG token syncs but its typing is DROPPED', async () => {
    const ro = (await tokensRepo.createOrgToken(orgId, 'svc-ro', ['read'] as never)).token;
    const { persisted, contentMd } = await typeOverWebSocket(ro, 'SIN-SCOPE ');
    expect(persisted).not.toContain('SIN-SCOPE');
    expect(contentMd).not.toContain('SIN-SCOPE');
  });

  it('collab: an ORG token WITH the write scope is persisted', async () => {
    const rw = (await tokensRepo.createOrgToken(orgId, 'svc-rw', ['read', 'write'] as never)).token;
    const { persisted, contentMd } = await typeOverWebSocket(rw, 'CON-SCOPE ');
    expect(persisted).toContain('CON-SCOPE');
    expect(contentMd).toContain('CON-SCOPE');
  });

  // The MCP session registry is keyed by a header the client sets. As a plain
  // object, `sessions['__proto__']` returned Object.prototype — truthy, and
  // not a session — which then flowed into the request path. It is a Map now,
  // so these lookups miss like any other unknown id.
  it('MCP: prototype keys as a session id are treated as unknown sessions', async () => {
    for (const sid of ['__proto__', 'constructor', 'prototype']) {
      const res = await mcpPost(
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        editorToken,
        sid,
      );
      const raw = await res.text();
      // Unknown session → the 404 "re-initialize" answer, never a crash and
      // never a served request.
      expect(res.status).toBe(404);
      expect(raw).toMatch(/unknown or expired mcp session/i);
    }
  });
});
