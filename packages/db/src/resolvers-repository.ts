import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { resolverAllowlist, resolverCache } from './schema';

export interface AllowlistEntry {
  id: string;
  orgId: string;
  host: string;
  tokenSealed: string | null;
  note: string | null;
  createdAt: Date;
}

/** Safe to hand to a client: the credential is reduced to a boolean. */
export type RedactedAllowlistEntry = Omit<AllowlistEntry, 'tokenSealed'> & { hasToken: boolean };

export interface CachedValue {
  noteId: string;
  name: string;
  value: string | null;
  fetchedAt: Date | null;
  error: string | null;
  attemptedAt: Date;
}

/**
 * Resolvers: the operator's allowlist, and the last value each source gave.
 *
 * The two halves are separate on purpose. The allowlist is a decision an admin
 * makes about the outside world; the cache is data derived from notes and
 * dies with them.
 */
export class DrizzleResolversRepository {
  constructor(private readonly db: Db) {}

  // ── Allowlist ──────────────────────────────────────────────────────────

  async listAllowed(orgId: string): Promise<RedactedAllowlistEntry[]> {
    const rows = await this.db
      .select()
      .from(resolverAllowlist)
      .where(eq(resolverAllowlist.orgId, orgId));
    return rows.map(({ tokenSealed, ...rest }) => ({ ...rest, hasToken: tokenSealed !== null }));
  }

  /** Hosts only — what the check needs, without carrying credentials around. */
  async allowedHosts(orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ host: resolverAllowlist.host })
      .from(resolverAllowlist)
      .where(eq(resolverAllowlist.orgId, orgId));
    return rows.map((r) => r.host);
  }

  /** The entry for one host, credential included — for the code that fetches. */
  async entryForHost(orgId: string, host: string): Promise<AllowlistEntry | null> {
    const [row] = await this.db
      .select()
      .from(resolverAllowlist)
      .where(
        and(eq(resolverAllowlist.orgId, orgId), eq(resolverAllowlist.host, host.toLowerCase())),
      )
      .limit(1);
    return row ?? null;
  }

  async allow(input: {
    orgId: string;
    host: string;
    tokenSealed?: string | null;
    note?: string | null;
    createdBy?: string | null;
  }): Promise<RedactedAllowlistEntry> {
    const host = input.host.trim().toLowerCase();
    const keepToken = input.tokenSealed === undefined;
    await this.db
      .insert(resolverAllowlist)
      .values({
        orgId: input.orgId,
        host,
        tokenSealed: keepToken ? null : input.tokenSealed,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .onConflictDoUpdate({
        target: [resolverAllowlist.orgId, resolverAllowlist.host],
        set: {
          // Omitting the token keeps the stored one: an admin editing the note
          // beside a host cannot retype a credential they cannot read back.
          tokenSealed: keepToken
            ? sql`${resolverAllowlist.tokenSealed}`
            : (input.tokenSealed ?? null),
          note: input.note ?? null,
        },
      });
    const [row] = await this.db
      .select()
      .from(resolverAllowlist)
      .where(and(eq(resolverAllowlist.orgId, input.orgId), eq(resolverAllowlist.host, host)));
    const { tokenSealed, ...rest } = row!;
    return { ...rest, hasToken: tokenSealed !== null };
  }

  async revoke(orgId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(resolverAllowlist)
      .where(and(eq(resolverAllowlist.orgId, orgId), eq(resolverAllowlist.id, id)))
      .returning({ id: resolverAllowlist.id });
    return rows.length > 0;
  }

  // ── Cache ──────────────────────────────────────────────────────────────

  /** Everything known about a batch of notes' live values, in one read. */
  async cachedFor(noteIds: string[]): Promise<Map<string, CachedValue[]>> {
    const out = new Map<string, CachedValue[]>();
    if (noteIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(resolverCache)
      .where(inArray(resolverCache.noteId, noteIds));
    for (const r of rows) {
      const list = out.get(r.noteId) ?? [];
      list.push(r);
      out.set(r.noteId, list);
    }
    return out;
  }

  /**
   * Record an attempt.
   *
   * A failure keeps the previous value and its date rather than replacing
   * them: "could not reach it, and here is what it said an hour ago" is the
   * honest answer, and it needs both halves. Only a success moves
   * `fetched_at`, which is the date every answer quotes.
   */
  async record(
    noteId: string,
    spaceId: string,
    name: string,
    outcome: { ok: true; value: string } | { ok: false; error: string },
    at: Date = new Date(),
  ): Promise<void> {
    await this.db
      .insert(resolverCache)
      .values({
        noteId,
        spaceId,
        name,
        value: outcome.ok ? outcome.value : null,
        fetchedAt: outcome.ok ? at : null,
        error: outcome.ok ? null : outcome.error,
        attemptedAt: at,
      })
      .onConflictDoUpdate({
        target: [resolverCache.noteId, resolverCache.name],
        set: outcome.ok
          ? { value: outcome.value, fetchedAt: at, error: null, attemptedAt: at }
          : { error: outcome.error, attemptedAt: at },
      });
  }

  /**
   * Drop cached values a note no longer declares.
   *
   * `notInArray` rather than a hand-built list: these names come from the
   * note's markdown, which is user input, and interpolating them into SQL
   * would be an injection with an escaping function in front of it.
   */
  async prune(noteId: string, keep: string[]): Promise<void> {
    await this.db
      .delete(resolverCache)
      .where(
        keep.length === 0
          ? eq(resolverCache.noteId, noteId)
          : and(eq(resolverCache.noteId, noteId), notInArray(resolverCache.name, keep)),
      );
  }
}
