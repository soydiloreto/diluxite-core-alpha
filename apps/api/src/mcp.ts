import { liveBlock, liveValuesFor } from './live-values';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  identityUserId,
  canReadSpace,
  canWriteSpace,
  descendantFolderIds,
  factSentence,
  factsOf,
  freshnessNote,
  matchKeys,
  rankFactsForQuery,
  findFolderPath,
  folderPathOf,
  folderPaths,
  resolveFolderPath,
  TOKEN_SCOPE_WRITE,
  type Identity,
  type SpaceAuthzDeps,
  type WriteAttribution,
} from '@diluxite/core';
import { setScopeUser } from '@diluxite/db';
import type { AppDeps } from './app';
import { applyServerEdit, replaceWholeText } from './collab';
// Real workspace version (same pattern as services.ts) — the previous
// hardcoded '4.0.0-alpha.0' drifted away from the deployed version.
import pkg from '../package.json' with { type: 'json' };

/** Batch ceiling for read_notes: enough for a folder, short of a whole space. */
const READ_NOTES_MAX = 50;
/** Lower than the read ceiling: every item here is a write plus an index pass. */
const WRITE_NOTES_MAX = 25;

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

/**
 * Space access for the MCP identity — the SAME rule the REST layer applies,
 * imported rather than restated.
 *
 * It used to answer `isMember` for a user identity and ignore `write`
 * entirely, which meant a `viewer` could create, edit, move and delete notes
 * through an agent while the identical account got a 403 from the web app.
 * The tools below are a full write surface, so the role has to be honoured
 * here exactly as it is there.
 */
async function mcpSpaceAccess(
  deps: AppDeps,
  identity: Identity,
  spaceId: string,
  write: boolean,
): Promise<boolean> {
  const authz: SpaceAuthzDeps = { spaces: deps.spaces, organizations: deps.organizations };
  return write
    ? canWriteSpace(authz, identity, spaceId)
    : canReadSpace(authz, identity, spaceId);
}

/**
 * Tell the three refusals apart, so the agent gets something actionable
 * instead of a flat "No accessible space" it will retry forever: a read-only
 * org token, a member whose ROLE is read-only, and genuinely no access. The
 * viewer wording matters now that the role is enforced here — before this,
 * that case did not exist because a viewer was silently allowed to write.
 */
function writeDeniedMessage(identity: Identity): string {
  if (identity.kind === 'org' && !identity.scopes.includes(TOKEN_SCOPE_WRITE)) {
    return 'This org token is read-only (missing the "write" scope); writing is not allowed.';
  }
  return 'No space you can write to — you have either no access to it, or read-only access.';
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

  /**
   * This session's identity as a PROV attribution (ADR-002).
   *
   * The `generatedBy` is `mcp` for every tool, and that matters more here than
   * on any other surface: a note written by an agent looks exactly like one a
   * person typed, and six months later "did I decide this or did a model
   * suggest it" is a question the note body cannot answer.
   */
  const attribution = (): WriteAttribution =>
    ctx.identity.kind === 'user'
      ? { attributedTo: ctx.identity.userId, agentKind: 'user', generatedBy: 'mcp' }
      : { attributedTo: null, agentKind: 'org_token', generatedBy: 'mcp' };

  // Trace org-token writes via MCP (the main use case: a cron jotting
  // memories). User writes through MCP are intentionally not audited here —
  // same as the legacy behaviour; only org tokens need the actorless trace.
  const auditOrgWrite = async (action: string, resource: string): Promise<void> => {
    if (ctx.identity.kind !== 'org' || !deps.audit) return;
    await deps.audit.record({
      orgId: ctx.identity.orgId,
      action,
      resource,
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

  /**
   * The structured lane: which facts, if any, this question names.
   *
   * Returns a block ready to sit above the prose, or null when the question
   * names no key the space knows — in which case this cost one indexed
   * lookup and changed nothing.
   */
  const factsFor = async (spaceId: string, query: string): Promise<string | null> => {
    if (!deps.facts) return null;
    const keys = await deps.facts.keysIn(spaceId);
    const matched = matchKeys(query, keys);
    if (matched.length === 0) return null;

    const lines: string[] = [];
    for (const { key } of matched) {
      const hits = rankFactsForQuery(query, await deps.facts.lookup(spaceId, key));
      for (const h of hits) {
        const note = await deps.notes.get(h.noteId);
        // Every fact carries where it came from, down to the line. A fact
        // presented above the prose without a source is the confident,
        // uncheckable answer this whole design exists to avoid.
        const source = note ? ` — ${note.title}:${h.sourceLine}` : '';
        lines.push(`• ${factSentence(h)}${source}`);
      }
    }
    return lines.length > 0 ? `FACTS (exact, from tables):\n${lines.join('\n')}` : null;
  };

  server.tool(
    'search_memory',
    'Searches memory by meaning and keywords; returns the most relevant notes.',
    { query: z.string(), space: z.string().optional(), topK: z.number().optional() },
    async ({ query, space, topK }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      // THE STRUCTURED LANE, run on every query (ADR-001). It costs one
      // indexed lookup beside an embedding call already being paid for, which
      // is why no classifier decides whether a question "looks factual" — a
      // classifier would fail silently, saying prose while the exact row sat
      // unread. The space's own keys decide instead.
      const factBlock = await factsFor(target, query);

      const results = await deps.search.search(target, query, topK ?? 5);

      // ADR-001 step 3: the live lane. Bounded by the notes this search
      // actually returned, so the cost follows topK and never the corpus —
      // and nothing here waits long: a slow dashboard is served from cache
      // with its age rather than becoming a slow search.
      const live = liveBlock(
        await liveValuesFor(
          deps,
          target,
          results.map((r) => r.noteId),
        ),
      );
      // Freshness rides along on the results that have it, in plain words, and
      // ONLY when there is something to say — a caveat on every line is one
      // nobody reads, which costs exactly the cases where it mattered. The
      // reader here is a model composing an answer for a person, so the note
      // has to be usable as a sentence rather than parsed.
      const prose = results.length
        ? results
            .map((r, i) => {
              const note = r.freshness ? freshnessNote(r.freshness) : null;
              // Archived notes are answered, never hidden — the mark is what
              // tells the model this one was deliberately put away, so it can
              // say so instead of quoting it as current.
              const marks = [r.archived ? '🗄 archived' : null, note ? `⚠ ${note}` : null]
                .filter(Boolean)
                .join(' · ');
              // The id rides along so the model can pull the whole thing with
              // `expand_memory` — and only when it decides it needs to. A hit
              // that arrives as a full note spends context on the four results
              // that were not the answer.
              return `${i + 1}. ${r.title}${marks ? ` — ${marks}` : ''}\n   ${r.snippet}\n   ref: ${r.noteId}`;
            })
            .join('\n')
        : 'No results.';

      // Composed, never fused. Exact facts go ABOVE, labelled, because RRF
      // discards precisely the confidence signal that separates them from
      // prose — averaged in, the answer the reader came for lands third.
      // Composed, never fused, and in order of how much a reader should trust
      // it: a value resolved from its source now, then exact rows, then prose.
      const text = [live, factBlock, prose].filter(Boolean).join('\n\n---\n\n');
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
    'read_notes',
    'Reads several notes in ONE call: pass the ids and get every body back, each ' +
      'under a "## <title> (id: …)" heading. Prefer this over calling read_note in a ' +
      `loop — the round trip is what costs, not the read. Up to ${READ_NOTES_MAX} ids.`,
    { ids: z.array(z.string()) },
    async ({ ids }) => {
      if (ids.length === 0) return { content: [{ type: 'text', text: 'No ids given.' }] };
      if (ids.length > READ_NOTES_MAX) {
        return {
          content: [
            {
              type: 'text',
              text: `Too many ids (${ids.length}); the limit is ${READ_NOTES_MAX}. Split the batch.`,
            },
          ],
        };
      }
      const notes = await Promise.all(ids.map((id) => authorizedNote(id)));
      const found = notes
        .map((note, i) => (note ? `## ${note.title} (id: ${ids[i]})\n\n${note.contentMd}` : null))
        .filter((s): s is string => s !== null);
      // Naming the misses matters: silence would read as "that note is empty".
      const missing = ids.filter((_, i) => notes[i] === null);
      const parts = [...found];
      if (missing.length > 0) parts.push(`Not found: ${missing.join(', ')}`);
      return { content: [{ type: 'text', text: parts.join('\n\n---\n\n') }] };
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
      // POST /api/spaces/:id/notes rejects a blank title; this path has to agree,
      // or MCP becomes the way to get untitled rows into a space.
      if (!title.trim()) return { content: [{ type: 'text', text: 'A title is required.' }] };
      const folderId = await resolveFolderPath(deps.folders, target, folder);
      const note = await deps.notes.openOrCreate(target, title, folderId);
      await auditOrgWrite('note.written', `note:${note.id}`);
      // Report where the note ACTUALLY is, which is not the requested path when
      // it already existed somewhere else.
      const path = folderPathOf(await deps.folders.list(target), note.folderId ?? null);
      const where = path ? ` in ${path}` : '';
      if (deps.collab) {
        await writeContent(note.id, (text) => replaceWholeText(text, content));
        return { content: [{ type: 'text', text: `Saved "${title}"${where} (id: ${note.id}).` }] };
      }
      const updated = await deps.notes.update(note.id, { contentMd: content }, attribution());
      return {
        content: [{ type: 'text', text: `Saved "${title}"${where} (id: ${updated?.id}).` }],
      };
    },
  );

  server.tool(
    'write_notes',
    'Creates or updates SEVERAL notes in one call — same contract as write_note, ' +
      'per item: matched by title, optional `folder` path applied only when the note ' +
      `is created. Up to ${WRITE_NOTES_MAX} at a time. Reports created vs updated per ` +
      'note, and keeps going if one fails.',
    {
      notes: z.array(
        z.object({ title: z.string(), content: z.string(), folder: z.string().optional() }),
      ),
      space: z.string().optional(),
    },
    async ({ notes, space }) => {
      const target = await spaceFor(space, true);
      if (!target) {
        return { content: [{ type: 'text', text: writeDeniedMessage(ctx.identity) }] };
      }
      if (notes.length === 0) return { content: [{ type: 'text', text: 'No notes given.' }] };
      if (notes.length > WRITE_NOTES_MAX) {
        return {
          content: [
            {
              type: 'text',
              text: `Too many notes (${notes.length}); the limit is ${WRITE_NOTES_MAX}. Split the batch.`,
            },
          ],
        };
      }

      // Sequential on purpose: the collab path mutates one Y.Doc per note, and a
      // partial batch has to be reportable item by item, in the order asked.
      const lines: string[] = [];
      for (const item of notes) {
        try {
          if (!item.title.trim()) throw new Error('a title is required');
          const folderId = await resolveFolderPath(deps.folders, target, item.folder);
          const { note, created } = await deps.notes.openOrCreateDetailed(
            target,
            item.title,
            folderId,
          );
          await auditOrgWrite('note.written', `note:${note.id}`);
          if (deps.collab) {
            await writeContent(note.id, (text) => replaceWholeText(text, item.content));
          } else {
            await deps.notes.update(note.id, { contentMd: item.content }, attribution());
          }
          const path = folderPathOf(await deps.folders.list(target), note.folderId ?? null);
          const where = path ? ` in ${path}` : '';
          lines.push(`${created ? 'Created' : 'Updated'} "${item.title}"${where} (id: ${note.id}).`);
        } catch (e) {
          // One bad item must not sink the batch, but it must be visible.
          lines.push(`Failed "${item.title}": ${(e as Error).message}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
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
      await auditOrgWrite('note.appended', `note:${note.id}`);
      if (deps.collab) {
        await writeContent(note.id, (text) => {
          const sep = text.length > 0 ? '\n' : '';
          text.insert(text.length, `${sep}${content}`);
        });
        return { content: [{ type: 'text', text: `Appended to "${note.title}".` }] };
      }
      const next = note.contentMd ? `${note.contentMd}\n${content}` : content;
      await deps.notes.update(note.id, { contentMd: next }, attribution());
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
      await auditOrgWrite('note.moved', `note:${note.id}`);
      const path = folderPathOf(await deps.folders.list(note.spaceId), folderId);
      return {
        content: [{ type: 'text', text: `Moved "${note.title}" to ${path || 'the root'}.` }],
      };
    },
  );

  server.tool(
    'list_folders',
    'Lists the folder paths in a space, each with how many notes sit directly in it. ' +
      'These are the paths the other tools take: write_note, move_note, delete_folder.',
    { space: z.string().optional() },
    async ({ space }) => {
      const target = await spaceFor(space);
      if (!target) return { content: [{ type: 'text', text: 'No accessible space.' }] };
      const paths = folderPaths(await deps.folders.list(target));
      const notes = await deps.notes.list(target);
      const direct = new Map<string, number>();
      for (const n of notes) {
        if (n.folderId) direct.set(n.folderId, (direct.get(n.folderId) ?? 0) + 1);
      }
      const text =
        paths
          .map(({ id, path }) => {
            const count = direct.get(id) ?? 0;
            return `- ${path} (${count} note${count === 1 ? '' : 's'})`;
          })
          .join('\n') || 'No folders.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool(
    'delete_folder',
    'PERMANENTLY deletes a folder by path like "Dailies/2026-08". Unlike delete_note ' +
      'this does NOT use the trash and cannot be undone: the notes inside are erased, ' +
      'not trashed. A folder holding anything is refused unless you pass recursive: true, ' +
      'and the refusal tells you what is inside.',
    { folder: z.string(), recursive: z.boolean().optional(), space: z.string().optional() },
    async ({ folder, recursive, space }) => {
      const target = await spaceFor(space, true);
      if (!target) {
        return { content: [{ type: 'text', text: writeDeniedMessage(ctx.identity) }] };
      }
      const all = await deps.folders.list(target);
      const found = findFolderPath(all, folder);
      if (!found) return { content: [{ type: 'text', text: 'Not found.' }] };

      const subtree = descendantFolderIds(all, found.id);
      const notes = (await deps.notes.list(target)).filter(
        (n) => n.folderId !== null && subtree.includes(n.folderId),
      );
      const subfolders = subtree.length - 1;
      if ((notes.length > 0 || subfolders > 0) && recursive !== true) {
        const holds = [
          notes.length > 0 ? `${notes.length} note${notes.length > 1 ? 's' : ''}` : null,
          subfolders > 0 ? `${subfolders} subfolder${subfolders > 1 ? 's' : ''}` : null,
        ]
          .filter(Boolean)
          .join(' and ');
        return {
          content: [
            {
              type: 'text',
              text:
                `"${folder}" holds ${holds}. Deleting it erases them permanently — ` +
                'they do NOT go to the trash. Pass recursive: true to go ahead, or move ' +
                'what you want to keep out first.',
            },
          ],
        };
      }

      // One delete: the database cascades to subfolders and to the notes in them.
      await deps.folders.delete(found.id);
      await auditOrgWrite('folder.deleted', `folder:${found.id}`);
      const erased = [
        notes.length > 0 ? `${notes.length} note${notes.length > 1 ? 's' : ''}` : null,
        subfolders > 0 ? `${subfolders} subfolder${subfolders > 1 ? 's' : ''}` : null,
      ]
        .filter(Boolean)
        .join(' and ');
      return {
        content: [
          {
            type: 'text',
            text: erased
              ? `Deleted "${folder}" and everything inside: ${erased}. This was permanent.`
              : `Deleted the empty folder "${folder}".`,
          },
        ],
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
      await auditOrgWrite('note.deleted', `note:${note.id}`);
      return { content: [{ type: 'text', text: `Moved "${note.title}" to the trash.` }] };
    },
  );

  server.tool(
    'expand_memory',
    'Given a `ref` from search_memory, returns everything known about that note: its full text, who wrote it and whether it still holds, the exact rows it states, and any live values it declares. Use it when a search hit looks like the answer and you need the whole thing — search_memory deliberately returns only the matching passage.',
    { ref: z.string() },
    async ({ ref }) => {
      const note = await authorizedNote(ref);
      if (!note) return { content: [{ type: 'text', text: 'Not found.' }] };

      const parts: string[] = [`# ${note.title}\n\n${note.contentMd}`];

      // Standing first: whether this still holds changes how the rest should
      // be read, and a reader who learns it afterwards has already believed it.
      if (deps.provenance) {
        const row = await deps.provenance.get('note', note.id);
        if (row) {
          const expired = !!row.validTo && row.validTo.getTime() <= Date.now();
          const standing =
            row.rank === 'deprecated'
              ? 'NO LONGER TRUE — kept so that what was believed then stays answerable'
              : expired
                ? `EXPIRED on ${row.validTo!.toISOString().slice(0, 10)}`
                : row.confirmedAt
                  ? `confirmed on ${row.confirmedAt.toISOString().slice(0, 10)}`
                  : 'nobody has confirmed it';
          parts.push(`STANDING: ${standing}`);
        }
      }

      const live = liveBlock(await liveValuesFor(deps, note.spaceId, [note.id]));
      if (live) parts.push(live);

      if (deps.facts) {
        const rows = factsOf(note.contentMd);
        if (rows.length > 0) {
          parts.push(
            `EXACT ROWS (from this note's tables):\n${rows
              .map((f) => `• ${f.key} — ${f.column}: ${f.value} (line ${f.line})`)
              .join('\n')}`,
          );
        }
      }

      return { content: [{ type: 'text', text: parts.join('\n\n---\n\n') }] };
    },
  );

  server.tool(
    'mark_superseded',
    "Marks a note as no longer true. It stays readable and searchable, flagged as superseded — nothing is deleted, so \"what did we believe back then\" is still answerable. Use this instead of delete_note when the information was right and stopped being right.",
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
      if (!deps.provenance)
        return { content: [{ type: 'text', text: 'This deployment does not record validity.' }] };
      await deps.provenance.supersede('note', note.id);
      await auditOrgWrite('note.superseded', `note:${note.id}`);
      return {
        content: [{ type: 'text', text: `"${note.title}" is marked as no longer true. It is still readable.` }],
      };
    },
  );

  server.tool(
    'set_note_expiry',
    'Declares the date a note stops being true — a contract end, a rotating credential, a quarterly figure. Until that date the note is treated as current; after it, answers say it expired. Pass null to clear it. This is for dates the world imposes; ordinary ageing is measured on its own.',
    { id: z.string(), validTo: z.string().nullable() },
    async ({ id, validTo }) => {
      const note = await authorizedNote(id, true);
      if (!note) {
        return {
          content: [
            { type: 'text', text: noteWriteDenied() ? writeDeniedMessage(ctx.identity) : 'Not found.' },
          ],
        };
      }
      if (!deps.provenance)
        return { content: [{ type: 'text', text: 'This deployment does not record validity.' }] };
      const at = validTo === null ? null : new Date(validTo);
      if (at && Number.isNaN(at.getTime()))
        return { content: [{ type: 'text', text: `"${validTo}" is not a date.` }] };
      try {
        await deps.provenance.setValidTo('note', note.id, at);
      } catch {
        return {
          content: [{ type: 'text', text: 'That date is before the note existed.' }],
        };
      }
      await auditOrgWrite('note.expiry.set', `note:${note.id}`);
      return {
        content: [
          {
            type: 'text',
            text: at
              ? `"${note.title}" expires on ${at.toISOString().slice(0, 10)}.`
              : `"${note.title}" no longer has an expiry date.`,
          },
        ],
      };
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
      await auditOrgWrite('note.purged', `note:${note.id}`);
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
  // A Map, not a plain object. The key is the client-supplied
  // `mcp-session-id` header, and on `{}` the lookup `sessions['__proto__']`
  // returns Object.prototype instead of undefined — a truthy non-session that
  // then flows into the request path. CodeQL flagged the writes
  // (js/prototype-polluting-assignment); the reads were the sharper end. A Map
  // has no prototype keys, so the whole class disappears rather than being
  // guarded against.
  const sessions = new Map<string, McpSession>();

  const evict = (sid: string) => {
    const session = sessions.get(sid);
    if (!session) return;
    sessions.delete(sid);
    // close() triggers transport.onclose, which re-deletes — harmless.
    void session.transport.close().catch(() => {});
  };

  const sweepExpired = (now: number) => {
    for (const [sid, session] of sessions) {
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
      const session = sessionId ? sessions.get(sessionId) : undefined;
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
        // ADR-004: MCP resolves its own identity, so it publishes its own
        // scope. The onRequest hook opened an empty one for this request;
        // without this line every tool call would run privileged — the exact
        // hole that made the workspace role a lie on this surface once before.
        setScopeUser(identityUserId(identity));
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
          // The initialising request resolves its own identity too, and the
          // default space below is READ under it — so the scope goes up first.
          setScopeUser(identityUserId(identity));

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
              sessions.set(sid, {
                transport: transport!,
                identityKey: key,
                lastSeenAt: now,
                openStreams: 0,
              });
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid) sessions.delete(sid);
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
      const streamSession =
        req.method === 'GET' && sessionId ? sessions.get(sessionId) : undefined;
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
