import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { entityChangeStats, entityProvenance } from './schema';

/**
 * Provenance, validity, rank and change statistics — ADR-002.
 *
 * The three axes and the decay estimate for any entity. Today the only kind
 * is `note`; a table row becomes `fact` when query_facts lands and reuses
 * every row here unchanged.
 */

export type EntityKind = 'note' | 'fact';
export type EntityRank = 'preferred' | 'normal' | 'deprecated';
export type AgentKind = 'user' | 'org_token' | 'connector' | 'system' | 'unknown';

/**
 * Who and what produced a write. Assembled at the layer that KNOWS the
 * identity (a route, an MCP tool, the connector) and passed down — the
 * repository cannot invent it, and inventing it is the failure this whole
 * record exists to prevent.
 */
export interface WriteAttribution {
  /** The PROV Agent. Null when the writing path genuinely cannot name one. */
  attributedTo?: string | null;
  agentKind?: AgentKind;
  /** The PROV Activity — which door the write came through. */
  generatedBy?: string;
  derivedFromNoteId?: string | null;
  derivedFromLine?: number | null;
  derivedFromRef?: string | null;
}

export interface EntityProvenanceRow {
  entityKind: EntityKind;
  entityId: string;
  spaceId: string;
  attributedTo: string | null;
  agentKind: AgentKind;
  generatedBy: string;
  derivedFromNoteId: string | null;
  derivedFromLine: number | null;
  derivedFromRef: string | null;
  validFrom: Date;
  validTo: Date | null;
  recordedAt: Date;
  rank: EntityRank;
}

export interface EntityChangeStatsRow {
  entityKind: EntityKind;
  entityId: string;
  spaceId: string;
  firstSeenAt: Date;
  lastChangedAt: Date;
  changeCount: number;
  avgIntervalSeconds: number | null;
}

/**
 * Smoothing factor for the interval EWMA.
 *
 * 0.3 weights the most recent gap at 30% and lets roughly the last ~6 changes
 * dominate the estimate. Lower would make a note that just changed its habits
 * take too long to be believed; higher would let one unusual gap — a holiday,
 * a weekend, one frantic afternoon — redefine what "normal" means for that
 * note. It is a default, not a finding: the shape of the estimator comes from
 * the literature, this constant comes from wanting recent behaviour to win
 * without a single sample owning the answer.
 */
export const EWMA_ALPHA = 0.3;

/**
 * Fold one observed interval into the running average.
 *
 * Exported and pure so the arithmetic can be tested without a database — it
 * is the whole of the "learning" this system does, and it should be readable
 * as such: no model, no inference, one multiply-add.
 */
export function foldInterval(
  previousAverageSeconds: number | null,
  observedSeconds: number,
  alpha: number = EWMA_ALPHA,
): number {
  if (previousAverageSeconds === null) return observedSeconds;
  return alpha * observedSeconds + (1 - alpha) * previousAverageSeconds;
}

export class DrizzleEntityProvenanceRepository {
  constructor(private readonly db: Db) {}

  /**
   * Record (or amend) the provenance of an entity.
   *
   * `validFrom` defaults to now and `rank` to `normal`; a caller that knows
   * better — an import replaying history, a supersession — passes them.
   */
  async record(
    kind: EntityKind,
    entityId: string,
    spaceId: string,
    attribution: WriteAttribution = {},
    opts: { validFrom?: Date; rank?: EntityRank } = {},
  ): Promise<void> {
    const values = {
      entityKind: kind,
      entityId,
      spaceId,
      attributedTo: attribution.attributedTo ?? null,
      agentKind: attribution.agentKind ?? 'unknown',
      generatedBy: attribution.generatedBy ?? 'editor',
      derivedFromNoteId: attribution.derivedFromNoteId ?? null,
      derivedFromLine: attribution.derivedFromLine ?? null,
      derivedFromRef: attribution.derivedFromRef ?? null,
      ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
      ...(opts.rank ? { rank: opts.rank } : {}),
    };
    await this.db
      .insert(entityProvenance)
      .values(values)
      .onConflictDoUpdate({
        target: [entityProvenance.entityKind, entityProvenance.entityId],
        set: {
          attributedTo: values.attributedTo,
          agentKind: values.agentKind,
          generatedBy: values.generatedBy,
          derivedFromNoteId: values.derivedFromNoteId,
          derivedFromLine: values.derivedFromLine,
          derivedFromRef: values.derivedFromRef,
          recordedAt: new Date(),
          ...(opts.validFrom ? { validFrom: opts.validFrom } : {}),
          ...(opts.rank ? { rank: opts.rank } : {}),
        },
      });
  }

  async get(kind: EntityKind, entityId: string): Promise<EntityProvenanceRow | null> {
    const [row] = await this.db
      .select()
      .from(entityProvenance)
      .where(
        and(eq(entityProvenance.entityKind, kind), eq(entityProvenance.entityId, entityId)),
      )
      .limit(1);
    return (row as EntityProvenanceRow | undefined) ?? null;
  }

  /**
   * Close an entity's validity window and drop its rank to `deprecated`.
   *
   * The row STAYS. That is the whole point of the rank: "what did we believe
   * in March" has to remain answerable, and a delete makes it permanently
   * unanswerable. Idempotent — superseding twice does not move the window a
   * second time.
   */
  async supersede(
    kind: EntityKind,
    entityId: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.db
      .update(entityProvenance)
      .set({ validTo: at, rank: 'deprecated' })
      .where(
        and(
          eq(entityProvenance.entityKind, kind),
          eq(entityProvenance.entityId, entityId),
          sql`${entityProvenance.validTo} IS NULL`,
        ),
      );
  }

  // ── Change statistics ──────────────────────────────────────────────────

  /**
   * Fold one change into an entity's statistics.
   *
   * Constant time and constant space: reads one row, writes one row. There is
   * no scheduled job and no pass over the corpus anywhere in this design —
   * that is the alternative being rejected, not an optimisation deferred.
   *
   * The first change establishes the row and leaves the average NULL: one
   * observation is not an interval. From the second on, the gap since the
   * previous change is folded in.
   */
  async recordChange(
    kind: EntityKind,
    entityId: string,
    spaceId: string,
    at: Date = new Date(),
  ): Promise<void> {
    const existing = await this.stats(kind, entityId);
    if (!existing) {
      await this.db.insert(entityChangeStats).values({
        entityKind: kind,
        entityId,
        spaceId,
        firstSeenAt: at,
        lastChangedAt: at,
        changeCount: 1,
        avgIntervalSeconds: null,
      });
      return;
    }
    const observed = (at.getTime() - existing.lastChangedAt.getTime()) / 1000;
    // A non-positive gap means two writes inside the same clock tick, or a
    // clock that moved backwards. Neither is an interval worth learning from,
    // so the count advances and the average does not.
    const next =
      observed > 0 ? foldInterval(existing.avgIntervalSeconds, observed) : existing.avgIntervalSeconds;
    await this.db
      .update(entityChangeStats)
      .set({
        lastChangedAt: at,
        changeCount: existing.changeCount + 1,
        avgIntervalSeconds: next,
      })
      .where(
        and(eq(entityChangeStats.entityKind, kind), eq(entityChangeStats.entityId, entityId)),
      );
  }

  async stats(kind: EntityKind, entityId: string): Promise<EntityChangeStatsRow | null> {
    const [row] = await this.db
      .select()
      .from(entityChangeStats)
      .where(
        and(eq(entityChangeStats.entityKind, kind), eq(entityChangeStats.entityId, entityId)),
      )
      .limit(1);
    return (row as EntityChangeStatsRow | undefined) ?? null;
  }
}
