import { and, desc, eq, gte, lte, like, sql as drizzleSql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { auditEvents } from './schema';

/**
 * Append-only repository for security and admin audit events.
 *
 * Reads support the Admin → Audit UI: filter by org, actor, action prefix,
 * date range. Pagination is `at`-cursor based to scale past 100k rows without
 * OFFSET/LIMIT degradation; the UI passes the last seen `at` + `id` to fetch
 * the next page.
 *
 * NO update / delete. The whole point of an audit log is immutability — if
 * something is wrong, you append a correction event, you don't rewrite history.
 */

export interface AuditEvent {
  id: number;
  at: Date;
  orgId: string | null;
  actorId: string | null;
  action: string;
  resource: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface RecordEventInput {
  orgId?: string | null;
  actorId?: string | null;
  action: string;
  resource?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListFilters {
  orgId?: string;
  actorId?: string;
  actionPrefix?: string;
  /** Inclusive lower bound (ISO string or Date). */
  from?: Date;
  /** Inclusive upper bound. */
  to?: Date;
  limit?: number;
  /** Cursor: fetch events strictly older than this id. */
  beforeId?: number;
}

const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

export class DrizzleAuditEventsRepository {
  constructor(private readonly db: Db) {}

  /**
   * Deletes events older than `olderThan`. Returns the row count for callers
   * who want to log the sweep (the retention job in particular). Pure DELETE
   * — no soft-delete (the whole point is data minimization for compliance).
   */
  async deleteOlderThan(olderThan: Date): Promise<number> {
    // Cast to ISO string + ::timestamptz so the postgres driver doesn't have
    // to infer the parameter type. Some driver versions of postgres-js reject
    // Date directly bound through prepared statements (ERR_INVALID_ARG_TYPE).
    const iso = olderThan.toISOString();
    const r = await this.db
      .delete(auditEvents)
      .where(drizzleSql`${auditEvents.at} < ${iso}::timestamptz`);
    return (r as unknown as { count?: number }).count ?? 0;
  }

  async record(input: RecordEventInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      orgId: input.orgId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      resource: input.resource ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      // Drizzle's jsonb expects the JS value directly; postgres-js stringifies
      // under the hood. We seal as Record<string,unknown> in the type so
      // callers can't pass undefined/null fields by accident.
      metadata: (input.metadata ?? {}) as Record<string, unknown>,
    });
  }

  async list(filters: ListFilters = {}): Promise<AuditEvent[]> {
    const conds: SQL[] = [];
    if (filters.orgId) conds.push(eq(auditEvents.orgId, filters.orgId));
    if (filters.actorId) conds.push(eq(auditEvents.actorId, filters.actorId));
    if (filters.actionPrefix) {
      // `like` with no wildcard from caller — we control the pattern so
      // ESC chars in the user input can't break out. We escape `%` and `_`.
      const safe = filters.actionPrefix.replace(/[%_\\]/g, (c) => `\\${c}`);
      conds.push(like(auditEvents.action, `${safe}%`));
    }
    if (filters.from) conds.push(gte(auditEvents.at, filters.from));
    if (filters.to) conds.push(lte(auditEvents.at, filters.to));
    if (filters.beforeId !== undefined) {
      conds.push(drizzleSql`${auditEvents.id} < ${filters.beforeId}`);
    }

    const limit = Math.min(MAX_PAGE, Math.max(1, filters.limit ?? DEFAULT_PAGE));

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit);

    return rows.map(this.toDomain);
  }

  /**
   * Returns the count of events matching the same filters as `list`. Used by
   * the UI to show "showing 50 of 12,348" without paging through everything.
   * Has no `beforeId` filter — counts the full filter scope.
   */
  async count(filters: ListFilters = {}): Promise<number> {
    const conds: SQL[] = [];
    if (filters.orgId) conds.push(eq(auditEvents.orgId, filters.orgId));
    if (filters.actorId) conds.push(eq(auditEvents.actorId, filters.actorId));
    if (filters.actionPrefix) {
      const safe = filters.actionPrefix.replace(/[%_\\]/g, (c) => `\\${c}`);
      conds.push(like(auditEvents.action, `${safe}%`));
    }
    if (filters.from) conds.push(gte(auditEvents.at, filters.from));
    if (filters.to) conds.push(lte(auditEvents.at, filters.to));

    const [row] = await this.db
      .select({ c: drizzleSql<number>`count(*)::int` })
      .from(auditEvents)
      .where(conds.length > 0 ? and(...conds) : undefined);
    return row?.c ?? 0;
  }

  private toDomain(row: typeof auditEvents.$inferSelect): AuditEvent {
    return {
      id: row.id,
      at: row.at,
      orgId: row.orgId,
      actorId: row.actorId,
      action: row.action,
      resource: row.resource,
      ip: row.ip,
      userAgent: row.userAgent,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    };
  }
}
