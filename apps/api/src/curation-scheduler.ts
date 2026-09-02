import type { AppDeps } from './app';
import { buildCurationBatch } from './curation-build';

/**
 * The weekly batch, built without anybody pressing anything.
 *
 * This is the operational reason ADR-006 exists in the first place: the batch
 * has to be ready on Friday whether or not somebody opened a client that week.
 * A ritual that depends on a person remembering to start it is a ritual that
 * stops in the first busy quarter — which is exactly what the fixed human
 * budget is designed to survive.
 *
 * Note what it does NOT do: it never decides anything, never confirms and
 * never supersedes. It only proposes, and every proposal still waits for a
 * person.
 */

export interface CurationSchedulerHandle {
  stop(): void;
  /** Run one sweep now. Returns how many spaces were rebuilt. Used in tests. */
  runOnce(): Promise<number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often to LOOK. Cheap: one indexed query when nothing is due. */
const DEFAULT_TICK_MS = 60 * 60 * 1000;
export const DEFAULT_INTERVAL_DAYS = 7;

/**
 * `pg_try_advisory_lock` keyed on this, so two API replicas do not both
 * rebuild the same week's batch. Try, never wait: a second replica finding the
 * lock taken should skip the sweep, not queue up behind it.
 */
const LOCK_KEY = 4_206_101; // arbitrary, stable, and ours

export function startCurationScheduler(
  deps: AppDeps,
  sql: { unsafe: (q: string) => Promise<unknown[]> } & (<T = unknown>(
    ...args: never[]
  ) => Promise<T[]>),
  opts: { intervalDays?: number; tickMs?: number; now?: () => Date } = {},
): CurationSchedulerHandle {
  const intervalDays = opts.intervalDays ?? DEFAULT_INTERVAL_DAYS;
  // Zero or negative turns it off — an operator who wants the button and
  // nothing else says so, and the code has one way to read that.
  if (!deps.curation || !Number.isFinite(intervalDays) || intervalDays <= 0) {
    return { stop() {}, runOnce: async () => 0 };
  }
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const now = opts.now ?? (() => new Date());

  async function sweep(): Promise<number> {
    const [lock] = (await sql.unsafe(
      `SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`,
    )) as { locked: boolean }[];
    if (!lock?.locked) return 0;
    try {
      const cutoff = new Date(now().getTime() - intervalDays * DAY_MS);
      const due = await deps.curation!.spacesDueForBuild(cutoff);
      let rebuilt = 0;
      for (const spaceId of due) {
        // One space failing — a drafting endpoint down, say — must not stop
        // the others: the sweep is the only chance they get this week.
        try {
          const r = await buildCurationBatch(deps, spaceId);
          if (r && r.built > 0) rebuilt++;
        } catch (e) {
          console.error(`curation-scheduler: space ${spaceId} failed:`, e);
        }
      }
      if (rebuilt > 0) console.log(`🗂  curation: rebuilt the batch for ${rebuilt} space(s)`);
      return rebuilt;
    } finally {
      await sql.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
    }
  }

  const timer = setInterval(() => {
    sweep().catch((e) => console.error('curation-scheduler sweep failed:', e));
  }, tickMs);
  // Never pin the event loop for this: SIGTERM should still exit cleanly.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return { stop: () => clearInterval(timer), runOnce: sweep };
}
