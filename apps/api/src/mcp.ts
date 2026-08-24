import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  folderPathOf,
  resolveFolderPath,
  TOKEN_SCOPE_READ,
  TOKEN_SCOPE_WRITE,
  type Identity,
} from '@diluxite/core';
import type { AppDeps } from './app';
import { applyServerEdit, replaceWholeText } from './collab';
// Real workspace version (same pattern as services.ts) — the previous
// hardcoded '4.0.0-alpha.0' drifted away from the deployed version.
import pkg from '../package.json' with { type: 'json' };

export interface McpContext {
  /**
   * Who the session is acting as — a user OR an unattended org token. The tools
   * authorise every space access against this, so a user only reaches their
   * memberships and an org token only reaches its org's spaces (and only writes
   * with the `write` scope).
   */
  identity: Identity;
  defaultSpaceId: string | null;
}

/** Space access for the MCP identity: a user must be a member; an org token
 *  needs the space to be in its org AND the matching scope (read|write). */
async function mcpSpaceAccess(
  deps: AppDeps,
  identity: Identity,
  spaceId: string,
  write: boolean,
): Promise<boolean> {
  if (identity.kind === 'user') return deps.spaces.isMember(spaceId, identity.userId);
  const scope = write ? TOKEN_SCOPE_WRITE : TOKEN_SCOPE_READ;
  return identity.scopes.includes(scope) && deps.spaces.isSpaceInOrg(spaceId, identity.orgId);
}

/**
 * Distinguish "no such space / no access" from "you have the space but lack
 * the write scope", so a read-only org token gets a clear, actionable error
 * (not a confusing "No accessible space") and never a 500.
 */
function writeDeniedMessage(identity: Identity): string {
  if (identity.kind === 'org' && !identity.scopes.includes(TOKEN_SCOPE_WRITE)) {
    return 'This org token is read-only (missing the "write" scope); writing is not allowed.';
  }
  return 'No accessible space.';
}

/** MCP server with the super-memory tools, scoped to one identity (PRD §13). */
export function createMcpServer(deps: AppDeps, ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'diluxite', version: pkg.version });

  // Resolves and authorises the space for a READ (default = the identity's
  // first accessible space). Returns null when there's no access (or, for a
  // read-only org token attempting a write space, the write variant below).
  const spaceFor = async (space: string | undefined, write = false): Promise<string | null> => {
    const target = space ?? ctx.defaultSpaceId;
    if (!target) return null;
    return (await mcpSpaceAccess(deps, ctx.identity, target, write)) ? target : null;
  };

  const authorizedNote = async (id: string, write = false) => {
    const note = await deps.notes.get(id);
    return note && (await mcpSpaceAccess(deps, ctx.identity, note.spaceId, write)) ? note : null;
  };

  // Same as authorizedNote but resolves trashed rows too — `get` hides them,
  // and purge_note needs to look up a note that's already in the trash.
  const authorizedTrashedNote = async (id: string, write = true) => {
    const note = await deps.notes.getIncludingTrashed(id);
    return note && (await mcpSpaceAccess(deps, ctx.identity, note.spaceId, write)) ? note : null;
  };

  // For the destructive tools: a null note means either no access OR a
  // read-only org token. Surface the read-only case as an actionable error.
  const noteWriteDenied = (): boolean =>
    ctx.identity.kind === 'org' && !ctx.identity.scopes.includes(TOKEN_SCOPE_WRITE);

  // Trace org-token writes via MCP (the main use case: a cron jotting
  // memories). User writes through MCP are intentionally not audited here —
  // same as the legacy behaviour; only org tokens need the actorless trace.
  const auditOrgWrite = async (action: string, noteId: string): Promise<void> => {
    if (ctx.identity.kind !== 'org' || !deps.audit) return;
    await deps.audit.record({
      orgId: ctx.identity.orgId,
      action,
      resource: `note:${noteId}`,
      metadata: { orgTokenId: ctx.identity.tokenId, via: 'mcp' },
    });
  };

  // Write-path bridge: when collab is wired, content writes go through the
  // live Y.Doc (applyServerEdit) so the next onStoreDocument flush doesn't
  // overwrite them with the stale in-memory state. Same mechanism as
  // POST /api/notes/:id/append in app.ts.
  const writeContent = async (noteId: string, mutate: (text: import('yjs').Text) => void) => {
    await applyServerEdit(
      {
        auth: deps.auth,
        notes: deps.collab!.notesRepo,
        yjs: deps.collab!.yjs,
        indexer: deps.collab!.indexer,
      },
      noteId,
      mutate,
      deps.collab!.hocuspocus as unknown as { documents: Map<string, { name: string }> },
    );
  };

  server.tool(
    'search_memory',
    'Searches memory by meaning and keywords; returns the most relevant notes.',
    { query: z.string(), space: z.string().optional(), topK: z.number().optional() },
    async ({ query, space, topK }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const results = await deps.search.search(target, query, topK ?? 5);
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join('\n')
        : 'No results.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'list_notes',
    'Lists every note in a space.',
    { space: z.string().optional() },
    async ({ space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const notes = await deps.notes.list(target);
      const text = notes.length
        ? notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n')
        : 'No notes.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'read_note',
    'Reads the full content of a note by id.',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedNote(id);
      return { content: [{ type: 'text', text: note ? note.contentMd : 'Not found.' }] };
    },
  );

  server.tool(
    'write_note',
    'Creates or updates a note by title (stores a memory). Pass `folder` to file ' +
      'a NEW note in a folder path like "Dailies/2026-08" — missing folders are ' +
      'created. A note that already exists is never moved: it is updated where it is.',
    {
      title: z.string(),
      content: z.string(),
      space: z.string().optional(),
      folder: z.string().optional(),
    },
    async ({ title, content, space, folder }) => {
      const target = await spaceFor(space, true);
      if (!target) {
        return {
          content: [{ type: 'text', text: writeDeniedMessage(ctx.identity) }],
        };
      }
      const folderId = await resolveFolderPath(deps.folders, target, folder);
      const note = await deps.notes.openOrCreate(target, title, folderId);
      await auditOrgWrite('note.written', note.id);
      // Report where the note ACTUALLY is, which is not the requested path when
      // it already existed somewhere else.
      const path = folderPathOf(await deps.folders.list(target), note.folderId ?? null);
      const where = path ? ` in ${path}` : '';
      if (deps.collab) {
        await writeContent(note.id, (text) => replaceWholeText(text, content));
        return { content: [{ type: 'text', text: `Saved "${title}"${where} (id: ${note.id}).` }] };
      }
      const updated = await deps.notes.update(note.id, { contentMd: content });
      return {
        content: [{ type: 'text', text: `Saved "${title}"${where} (id: ${updated?.id}).` }],
      };
    },
  );

  server.tool('list_spaces', 'Lists the workspaces (spaces) you can reach.', {}, async () => {
    // A user sees their memberships; an org token sees every space in its org.
    const spaces =
      ctx.identity.kind === 'user'
        ? await deps.spaces.listForUser(ctx.identity.userId)
        : await deps.spaces.listForOrg(ctx.identity.orgId);
    const text = spaces.map((s) => `- ${s.name} (id: ${s.id})`).join('\n') || 'No spaces.';
    return { content: [{ type: 'text', text }] };
  });

  server.tool(
    'list_tags',
    'Lists the tags in a space with their note count.',
    { space: z.string().optional() },
    async ({ space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const tags = await deps.tags.listForSpace(target);
      const text = tags.map((t) => `#${t.tag} (${t.count})`).join('\n') || 'No tags.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'search_by_tag',
    'Returns the notes that carry a given tag.',
    { tag: z.string(), space: z.string().optional() },
    async ({ tag, space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const ids = new Set(await deps.tags.noteIdsByTag(target, tag));
      const notes = (await deps.notes.list(target)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No notes with that tag.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'recent_notes',
    'Lists the most recently updated notes.',
    { space: z.string().optional(), limit: z.number().optional() },
    async ({ space, limit }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const notes = (await deps.notes.list(target)).slice(0, limit ?? 10);
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No notes.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'backlinks_of',
    'Lists the notes that link to a given note (by id).',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedNote(id);
      if (!note) return { content: [{ type: 'text', text: 'Not found.' }] };
      const ids = new Set(await deps.links.backlinkIds(note.spaceId, note.title));
      const notes = (await deps.notes.list(note.spaceId)).filter((n) => ids.has(n.id));
      const text = notes.map((n) => `- ${n.title} (id: ${n.id})`).join('\n') || 'No backlinks.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'append_to_note',
    'Appends content to the end of a note (so the AI can "jot" memories).',
    { id: z.string(), content: z.string() },
    async ({ id, content }) => {
      const note = await authorizedNote(id, true);
      if (!note) {
        // Either the note isn't reachable, or this is a read-only org token.
        const denied =
          ctx.identity.kind === 'org' && !ctx.identity.scopes.includes(TOKEN_SCOPE_WRITE);
        return {
          content: [
            {
              type: 'text',
              text: denied
                ? 'This org token is read-only (missing the "write" scope); writing is not allowed.'
                : 'Not found.',
            },
          ],
        };
      }
      await auditOrgWrite('note.appended', note.id);
      if (deps.collab) {
        await writeContent(note.id, (text) => {
          const sep = text.length > 0 ? '\n' : '';
          text.insert(text.length, `${sep}${content}`);
        });
        return { content: [{ type: 'text', text: `Appended to "${note.title}".` }] };
      }
      const next = note.contentMd ? `${note.contentMd}\n${content}` : content;
      await deps.notes.update(note.id, { contentMd: next });
      return { content: [{ type: 'text', text: `Appended to "${note.title}".` }] };
    },
  );

  server.tool(
    'move_note',
    'Moves a note into a folder path like "Dailies/2026-08"; missing folders are ' +
      'created. Omit `folder` (or pass an empty string) to move it to the space root.',
    { id: z.string(), folder: z.string().optional() },
    async ({ id, folder }) => {
      const note = await authorizedNote(id, true);
      if (!note) {
        return {
          content: [
            { type: 'text', text: noteWriteDenied() ? writeDeniedMessage(ctx.identity) : 'Not found.' },
          ],
        };
      }
      const folderId = await resolveFolderPath(deps.folders, note.spaceId, folder);
      // Through the move repo, not notes.update: it is the same atomic path the
      // UI uses and it skips a pointless re-index (a move changes no content).
      await deps.move.moveItems({
        spaceId: note.spaceId,
        targetFolderId: folderId,
        noteIds: [note.id],
        folderIds: [],
      });
      await auditOrgWrite('note.moved', note.id);
      const path = folderPathOf(await deps.folders.list(note.spaceId), folderId);
      return {
        content: [{ type: 'text', text: `Moved "${note.title}" to ${path || 'the root'}.` }],
      };
    },
  );

  server.tool(
    'delete_note',
    'Moves a note to the trash (soft delete). It disappears from search and listings but can be restored from the trash, or removed for good with purge_note.',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedNote(id, true);
      if (!note) {
        return {
          content: [
            { type: 'text', text: noteWriteDenied() ? writeDeniedMessage(ctx.identity) : 'Not found.' },
          ],
        };
      }
      await deps.notes.delete(note.id);
      await auditOrgWrite('note.deleted', note.id);
      return { content: [{ type: 'text', text: `Moved "${note.title}" to the trash.` }] };
    },
  );

  server.tool(
    'purge_note',
    'Permanently deletes a note that is already in the trash. This cannot be undone and also removes its tags and links. Use delete_note first to move it to the trash.',
    { id: z.string() },
    async ({ id }) => {
      const note = await authorizedTrashedNote(id, true);
      if (!note) {
        return {
          content: [
            { type: 'text', text: noteWriteDenied() ? writeDeniedMessage(ctx.identity) : 'Not found.' },
          ],
        };
      }
      const purged = deps.notes.purge ? await deps.notes.purge(note.id) : false;
      if (!purged) {
        return {
          content: [
            {
              type: 'text',
              text: `"${note.title}" must be in the trash before purging — use delete_note first.`,
            },
          ],
        };
      }
      await auditOrgWrite('note.purged', note.id);
      return { content: [{ type: 'text', text: `Permanently deleted "${note.title}".` }] };
    },
  );

  return server;
}

/** Inactivity TTL for MCP sessions — a stale transport must not outlive the
 *  credential that opened it forever. Sweep is lazy (on each request). */
export const MCP_SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * Pure eviction predicate (exported for tests). A session is reclaimed only
 * when it has NO open SSE stream AND has been idle past the TTL. The open-stream
 * guard is the #11g fix: never tear a transport out from under a live stream.
 */
export function mcpSessionExpired(
  session: { lastSeenAt: number; openStreams: number },
  now: number,
  ttlMs: number = MCP_SESSION_TTL_MS,
): boolean {
  if (session.openStreams > 0) return false;
  return now - session.lastSeenAt > ttlMs;
}

/**
 * Stable key for an identity, so a session can be pinned to exactly the
 * credential that opened it. A user → `user:<id>`; an org token → `org:<tokenId>`
 * (the specific token, not just the org — revoking that token must invalidate
 * the session even if another org token is still valid). The scopes are part of
 * the key too, so a token whose scopes changed can't keep an old session.
 */
function identityKey(identity: Identity): string {
  return identity.kind === 'user'
    ? `user:${identity.userId}`
    : `org:${identity.tokenId}:${[...identity.scopes].sort().join(',')}`;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  /** Identity key the session was initialized with — every later request must re-resolve to it. */
  identityKey: string;
  lastSeenAt: number;
  /**
   * Count of in-flight long-lived streams (SSE GETs) on this session. A
   * client can hold an SSE open for hours without sending another request, so
   * `lastSeenAt` alone would let the TTL sweep evict it mid-stream. While this
   * is > 0 the session is "live" and exempt from eviction.
   */
  openStreams: number;
}

/** Mounts the MCP Streamable HTTP endpoint at /mcp (stateful per session, identity via AuthProvider). */
export function registerMcp(app: FastifyInstance, deps: AppDeps): void {
  const sessions: Record<string, McpSession> = {};

  const evict = (sid: string) => {
    const session = sessions[sid];
    if (!session) return;
    delete sessions[sid];
    // close() triggers transport.onclose, which re-deletes — harmless.
    void session.transport.close().catch(() => {});
  };

  const sweepExpired = (now: number) => {
    for (const [sid, session] of Object.entries(sessions)) {
      // Never evict a session with an open SSE stream (mcpSessionExpired
      // guards it) — the transport would close out from under a live
      // connection. Idle sessions past the TTL are reclaimed as before.
      if (mcpSessionExpired(session, now)) evict(sid);
    }
  };

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const now = Date.now();
      sweepExpired(now);

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? sessions[sessionId] : undefined;
      let transport = session?.transport;

      if (session && sessionId) {
        // Re-authenticate EVERY request against the session's identity. A
        // session id alone is not a credential: a revoked token must stop
        // working immediately, and a different user's token must never ride
        // an existing session.
        //
        // On failure we answer 401 but DO NOT evict the session. A single
        // unauthenticated/mis-credentialed request must not tear down a
        // session another (correctly authenticated) request — or an open SSE
        // stream — is using. The inactivity TTL sweep reclaims it later; a
        // revoked credential simply keeps getting 401 until then.
        const identity = await deps.auth.resolve(req.headers);
        if (!identity || identityKey(identity) !== session.identityKey) {
          reply.code(401).send({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthenticated' },
            id: null,
          });
          return;
        }
        // Any authenticated activity (POST, GET/SSE, DELETE) counts as
        // liveness — bump lastSeenAt so an open SSE stream isn't swept out
        // from under a long-lived connection.
        session.lastSeenAt = now;
      }

      if (!transport) {
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
          const identity = await deps.auth.resolve(req.headers);
          if (!identity) {
            reply.code(401).send({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'Unauthenticated' },
              id: null,
            });
            return;
          }
          // Default space: a user's first membership, or an org token's first
          // org space. So a single-space client needn't pass `space=` every call.
          const spaces =
            identity.kind === 'user'
              ? await deps.spaces.listForUser(identity.userId)
              : await deps.spaces.listForOrg(identity.orgId);
          const ctx: McpContext = { identity, defaultSpaceId: spaces[0]?.id ?? null };
          const key = identityKey(identity);

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions[sid] = {
                transport: transport!,
                identityKey: key,
                lastSeenAt: now,
                openStreams: 0,
              };
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) delete sessions[sid];
          };
          await createMcpServer(deps, ctx).connect(transport);
        } else {
          // A non-initialize request whose mcp-session-id we don't know.
          // The Streamable HTTP spec says the server SHOULD answer 404 for an
          // unknown/expired session id so the client can transparently
          // re-initialize. 400 (used before) made well-behaved clients give
          // up instead of re-handshaking.
          reply.code(404).send({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Unknown or expired MCP session — re-initialize' },
            id: null,
          });
          return;
        }
      }

      reply.hijack();

      // A GET opens a long-lived SSE stream. Mark the session as having an
      // open stream for as long as the connection lives, so the TTL sweep
      // doesn't tear it down mid-stream. We decrement (and bump lastSeenAt) on
      // close so the now-idle session ages out normally afterwards.
      const streamSession = req.method === 'GET' && sessionId ? sessions[sessionId] : undefined;
      if (streamSession) {
        streamSession.openStreams += 1;
        const onClose = () => {
          streamSession.openStreams = Math.max(0, streamSession.openStreams - 1);
          streamSession.lastSeenAt = Date.now();
        };
        reply.raw.once('close', onClose);
      }

      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  });
}
