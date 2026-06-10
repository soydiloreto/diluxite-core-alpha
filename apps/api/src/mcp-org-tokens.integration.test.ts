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
  DrizzleLinksRepository,
  DrizzleNotesRepository,
  DrizzleOrganizationsRepository,
  DrizzleSearchRepository,
  DrizzleSessionsRepository,
  DrizzleSpacesRepository,
  DrizzleTagsRepository,
  DrizzleTokensRepository,
  DrizzleUsersRepository,
} from '@diluxite/db';
import { buildApp, type AppDeps } from './app';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite_test';

/**
 * MCP is the PRIMARY use case for org tokens: a GitHub Action / cron consults
 * the second brain over MCP. We drive the Streamable HTTP endpoint with raw
 * JSON-RPC (so the Bearer can be set per request) and assert:
 *   - a read-only org token can search but NOT write,
 *   - a write org token can do both,
 *   - cross-org access is refused,
 *   - the isolation holds at the tool layer (not just REST).
 */
describe('MCP — org token scopes (integration)', () => {
  let app: FastifyInstance;
  let sql: Sql;
  let conn: ReturnType<typeof createDb>;
  let port: number;

  let tokensRepo: DrizzleTokensRepository;
  let orgAId: string;
  let orgBId: string;
  let spaceAId: string;
  let spaceBId: string;

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
    orgAId = (await orgs.create('Acme', `acme-${Date.now()}`, adminId)).id;
    orgBId = (await orgs.create('Beta', `beta-${Date.now()}`, adminId)).id;
    spaceAId = (await spaces.create(orgAId, 'Space A', adminId)).id;
    spaceBId = (await spaces.create(orgBId, 'Space B', adminId)).id;

    const notesRepo = new DrizzleNotesRepository(conn.db);
    const search = new SearchService(
      new DrizzleSearchRepository(conn.db),
      new DeterministicEmbeddingProvider(1536),
      notesRepo,
    );
    const notes = new NotesService(notesRepo, search);
    // Seed a memory in space A so search has something to find.
    const seeded = await notes.create({ spaceId: spaceAId, title: 'Azure', contentMd: '' });
    await notes.update(seeded.id, { contentMd: 'Azure is the Microsoft cloud' });

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

  // Parse the SSE/JSON response body into the tool result text.
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
    // Streamable HTTP returns SSE frames: pull the JSON after "data: ".
    const dataLine = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    const json = JSON.parse((dataLine ?? raw).replace(/^data:\s*/, ''));
    const content = json.result?.content ?? [];
    return content.map((c: { text: string }) => c.text).join('\n');
  }

  it('read-only org token: search_memory works, write_note refused by scope', async () => {
    const ro = (await tokensRepo.createOrgToken(orgAId, 'svc', ['read'] as never)).token;
    const sid = await initSession(ro);

    const search = await callToolText(ro, sid, 'search_memory', { query: 'microsoft cloud' });
    expect(search).toContain('Azure');

    const write = await callToolText(ro, sid, 'write_note', { title: 'X', content: 'y' });
    expect(write).toMatch(/read-only|write.*scope/i);
  });

  it('write org token: search AND write both succeed', async () => {
    const rw = (await tokensRepo.createOrgToken(orgAId, 'svc', ['read', 'write'] as never)).token;
    const sid = await initSession(rw);

    expect(await callToolText(rw, sid, 'search_memory', { query: 'microsoft cloud' })).toContain(
      'Azure',
    );
    const write = await callToolText(rw, sid, 'write_note', { title: 'Jot', content: 'memory' });
    expect(write).toMatch(/saved/i);
  });

  it('cross-org: an org-A token cannot reach org-B spaces via MCP', async () => {
    const rw = (await tokensRepo.createOrgToken(orgAId, 'svc', ['read', 'write'] as never)).token;
    const sid = await initSession(rw);

    // Explicitly targeting space B → no access.
    const read = await callToolText(rw, sid, 'list_notes', { space: spaceBId });
    expect(read).toMatch(/no accessible space/i);

    const write = await callToolText(rw, sid, 'write_note', {
      title: 'sneaky',
      content: 'x',
      space: spaceBId,
    });
    expect(write).toMatch(/no accessible space/i);

    // list_spaces only shows org A's spaces.
    const spaces = await callToolText(rw, sid, 'list_spaces', {});
    expect(spaces).toContain(spaceAId);
    expect(spaces).not.toContain(spaceBId);
  });
});
