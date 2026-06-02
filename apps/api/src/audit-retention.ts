import type { DrizzleAuditEventsRepository } from '@diluxite/db';

/**
 * Audit-log retention sweeper.
 *
 * Reads `DILUXITE_AUDIT_RETENTION_DAYS` at boot — if positive integer, runs
 * a sweep every hour that DELETEs `audit_events.at < now() - interval N days`.
 *
 * Off by default. SOC 2 typically wants ≥ 365d; GDPR data-minimization
 * argues for whatever's the minimum to investigate incidents (often 90d).
 * We leave it to the operator: hardcoding a default cuts both ways.
 *
 * The interval is hourly — frequent enough that retention drift never goes
 * past +1h, infrequent enough that we don't churn the DB. The deletion
 * runs even if there's no work to do (we trust the index to make it cheap).
 */

export interface RetentionHandle {
  stop(): void;
  /** Run the sweep immediately. Returns the rows deleted. Useful in tests. */
  runOnce(): Promise<number>;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startAuditRetention(
  audit: DrizzleAuditEventsRepository,
  opts: {
    retentionDays: number;
    /** Override the timer for tests so we don't have to wait an hour. */
    intervalMs?: number;
    /** Pure clock for tests. */
    now?: () => Date;
  },
): RetentionHandle {
  if (!Number.isFinite(opts.retentionDays) || opts.retentionDays <= 0) {
    return { stop() {}, runOnce: async () => 0 };
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());

  async function sweep(): Promise<number> {
    const cutoff = new Date(now().getTime() - opts.retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await audit.deleteOlderThan(cutoff);
    if (deleted > 0) {
      console.log(`🧹 audit-retention: deleted ${deleted} events older than ${cutoff.toISOString()}`);
    }
    return deleted;
  }

  const timer = setInterval(() => {
    sweep().catch((e) => {
      console.error('audit-retention sweep failed:', e);
    });
  }, intervalMs);
  // Don't pin the event loop just for this — Node should exit cleanly on SIGTERM.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => clearInterval(timer),
    runOnce: sweep,
  };
}
