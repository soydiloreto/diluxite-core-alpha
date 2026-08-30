import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import type { Db, DbTx } from './client';

/**
 * The per-request identity, and the machinery that makes Postgres enforce it
 * — ADR-004.
 *
 * Two planes. **Authentication** runs privileged: resolving a Bearer token
 * means reading `tokens` before the user is known, and its policy asks who the
 * user is, so gating it with RLS is circular by construction. **Data** runs as
 * `diluxite_app`, which is exempt from nothing, with `app.current_user_id`
 * published so the policies from migration 0003 can finally do their job.
 *
 * The scope is opened per REPOSITORY METHOD, not per request. Diluxite calls
 * an embedding model on every save and every semantic search — 100 ms to 2 s —
 * and a request-long scope would hold one of ten pooled connections idle for
 * the duration. Measured: +2.4 ms per scoped operation, and zero connections
 * left `idle in transaction` while a model call runs.
 *
 * Nothing here asks the twenty repositories or any route handler to
 * cooperate. That is deliberate: a mechanism people have to remember is one
 * that eventually gets forgotten, and the forgetting is silent.
 */

export interface TenantScope {
  /** `null` inside the auth plane: privileged, on purpose. */
  userId: string | null;
  /** Set while a scoped operation is running; nested calls reuse it. */
  tx?: DbTx;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** The identity in force, if any. */
export function currentScope(): TenantScope | undefined {
  return storage.getStore();
}

/**
 * Run `work` under `userId`.
 *
 * Called once per request, right after the identity is resolved. Passing
 * `null` enters a scope that is explicitly privileged — the auth routes and
 * the single-user bootstrap — which is different from being outside a scope
 * only in that it is written down.
 */
export function runInScope<T>(userId: string | null, work: () => Promise<T>): Promise<T> {
  return storage.run({ userId }, work);
}

/**
 * Open an empty scope around the rest of a request, and fill in the identity
 * later.
 *
 * The two halves exist because of when things are known. A framework hook can
 * only wrap what comes after it by running the continuation inside
 * `storage.run(...)` — which is available at the very start of a request,
 * before anyone has been authenticated. The identity arrives one hook later.
 *
 * So the store is created empty and MUTATED once the user is known. The
 * alternative, `storage.enterWith` in the identity hook, was tried and does
 * not work: it sets the store for the current async resource, and the
 * framework's continuation was created earlier, so every repository call
 * afterwards ran with no scope at all — silently, with every test still
 * passing. That is precisely the failure this whole design is meant to make
 * impossible, so it is written down here rather than remembered.
 *
 *   app.addHook('onRequest', (req, reply, done) => beginScope(done));
 *   // …once authenticated:
 *   setScopeUser(userId);
 */
export function beginScope(continuation: () => void): void {
  storage.run({ userId: null }, continuation);
}

/** Fill in the identity for the scope opened by `beginScope`. */
export function setScopeUser(userId: string | null): void {
  const scope = storage.getStore();
  if (scope) scope.userId = userId;
}

/**
 * The database handle the repositories hold.
 *
 * Resolves to the scope's transaction while one is open and to the pool
 * otherwise, so a repository written against `Db` needs no knowledge of any
 * of this.
 */
export function scopedDb(pool: Db): Db {
  return new Proxy(pool as object, {
    get(_target, prop, receiver) {
      const current = (storage.getStore()?.tx ?? pool) as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(current, prop, receiver);
      return typeof value === 'function' ? (value as () => unknown).bind(current) : value;
    },
  }) as Db;
}

/**
 * Wrap a repository so each of its methods runs under the current identity.
 *
 * Outside a scope, or inside one with no user, methods run as they always
 * have — privileged. That is what migrations, the bootstrap, the seed and the
 * auth plane need.
 *
 * A method called from inside another scoped method reuses the open
 * transaction rather than nesting a second one.
 */
export function tenantScoped<T extends object>(repo: T, pool: Db): T {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const scope = storage.getStore();
        if (!scope?.userId || scope.tx) {
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        return pool.transaction(async (tx) => {
          // Order matters: publish the identity BEFORE dropping privileges, so
          // the `set_config` call itself is not subject to the policies it is
          // about to enable.
          await tx.execute(sql`SELECT set_config('app.current_user_id', ${scope.userId}, true)`);
          await tx.execute(sql`SET LOCAL ROLE diluxite_app`);
          return storage.run({ ...scope, tx: tx as DbTx }, () =>
            (value as (...a: unknown[]) => unknown).apply(target, args),
          ) as Promise<unknown>;
        });
      };
    },
  });
}

/**
 * Whether this installation can actually enforce RLS.
 *
 * Answered at boot, because the failure mode is silent: an instance that
 * cannot assume the role behaves exactly like one that has no policies, and
 * nothing in the product would look different. Returns the reason when it
 * cannot, so the log says what to fix.
 */
export async function checkScopeUsable(pool: Db): Promise<{ ok: boolean; reason?: string }> {
  try {
    await pool.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE diluxite_app`);
      const rows = await tx.execute<{ ok: boolean }>(
        sql`SELECT current_setting('is_superuser') = 'off' AS ok`,
      );
      if (!rows[0]?.ok) throw new Error('the role is still superuser');
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
