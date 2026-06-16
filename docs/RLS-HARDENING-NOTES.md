# RLS Hardening Notes — checklist for the non-privileged role switch

> **Origin:** external review notes contributed from the **Dilux AI Studio** project
> (2026-06-16), where the same RLS model (its ADR-0012, mirrored from Diluxite) was
> implemented and validated empirically (Postgres 17). Diluxite already states, in
> `packages/db/migrations/0019_rls_resync.sql`, that production currently connects as the
> owner/superuser and RLS is *"effectively a no-op… that switch is the owner's call."*
> This document is the **how** for that switch, plus the hardening items found along the way.
>
> Source of truth in this repo: `packages/db/src/with-identity.ts`,
> `packages/db/migrations/0003_row_level_security.sql`, `…/0019_rls_resync.sql`,
> `docs/SECURITY.md`, `docs/MULTI-TENANT.md`.

## TL;DR

The RLS policies are correct and deny-by-default, but **dormant** until two things happen
together:

1. the app stops connecting as a superuser, **and**
2. every tenant-scoped query runs through `withIdentity`.

They are a package deal. Flipping the role without wiring `withIdentity` breaks reads
(fail-closed: 0 rows). Wiring `withIdentity` without flipping the role keeps RLS a no-op.

---

## 1. Wire `withIdentity` into the request path (the missing piece)

- `withIdentity` is defined but **not called by any handler** — a grep of `apps/` for
  `withIdentity` / `set_config` / `current_user_id` comes back empty. Until it is wired, the
  per-request identity is never published and the policies always see an empty user id.
- Set the identity **once per request, scoped to the DB work only** — *not* around the whole
  HTTP handler. Keep external waits (LLM calls, network, SSE) **outside** the transaction
  (see §4).
- Bootstrap paths keep using `withoutIdentity` + the `BYPASSRLS` role, as already documented
  in `docs/MULTI-TENANT.md`: migrations, `ensureSingleUserBootstrap`, and the
  login-by-email / session-token lookups that run *before* the identity is known.
- Make a forgotten `withIdentity` **loud, not silent**: rely on fail-closed (0 rows) plus
  integration tests that run under the non-super role, and/or an `AsyncLocalStorage` flag that
  asserts tenant-scoped repositories are only entered inside an identity scope.

## 2. Connect as a non-superuser role — with **no fallback**

- Production (and ideally dev/CI) should connect as a role that is `NOSUPERUSER` and
  `NOBYPASSRLS`. Superusers bypass RLS entirely; table owners bypass unless `FORCE` — you
  already use `FORCE ROW LEVEL SECURITY`, which is correct.
- **Do not** add a "fallback to the superuser URL if the app-role env var is missing." That
  silently disables RLS in exactly the environments where a misconfiguration is most likely.
  Fail hard at boot instead.
- Run **dev/CI under the non-super role** too (not only `SET ROLE` inside dedicated RLS
  tests). That keeps RLS alive everywhere and catches isolation bugs in dev rather than prod.
  Pattern that works: fixtures/seed connect as superuser (to set up cross-tenant data), the
  app connects as the non-super role (so policies actually apply).

## 3. Close the `SECURITY DEFINER` search_path vector

- The `diluxite_*` membership functions are `SECURITY DEFINER` (correct — they break policy
  recursion) and set `SET search_path = public`.
- A `SECURITY DEFINER` function owned by a superuser runs with `BYPASSRLS`. If an attacker can
  **create an object** in a schema on the function's `search_path`, they can shadow a
  referenced object and execute code with the owner's privileges (see Cybertec, below).
- **Mitigation, validated empirically in Dilux AI Studio:** ensure the app role **cannot
  `CREATE` in `public`** — i.e. `has_schema_privilege('app_role','public','CREATE') = false`.
  Grant the app role only `USAGE` on the schema + DML on tables, never `CREATE`. With that, the
  shadowing vector is closed.
- Defense-in-depth: prefer `SET search_path = pg_catalog, pg_temp` (or `''`) and
  schema-qualify every referenced table, so the function never resolves a name through a
  writable schema.

## 4. Transaction scope: keep it tight (validated)

- `withIdentity` opens a transaction and runs `work` inside it. **Keep `work` limited to DB
  operations.**
- Empirically (Postgres 17, Prisma-style pool = `ncpu*2+1`): an open transaction **pins its
  pooled connection for its entire lifetime**. If a handler `await`s an LLM (seconds to hours)
  *inside* the transaction, that connection is held the whole time → pool exhaustion under
  concurrency.
- Long-running jobs should run as **background work with one short transaction per step**, not
  as a single long-lived transaction tied to an HTTP request.
- Diluxite already does this right, by design, via explicit and narrow `withIdentity`. It is
  documented here because Dilux AI Studio initially got it wrong (a global per-request
  interceptor that wrapped the whole handler) and paid for it — a cautionary confirmation that
  the Diluxite approach is the correct one.

## 5. Non-issue, checked: `WITH CHECK`

- Diluxite policies use only `USING` (no explicit `WITH CHECK`). **This is not a write hole.**
  When `WITH CHECK` is omitted, Postgres reuses the `USING` expression as the write check, so
  `INSERT`/`UPDATE` are still constrained to rows the user can see.
- Add an explicit `WITH CHECK` only where the **write predicate must differ from the read
  predicate** (rare — e.g. allow reading a row but forbid moving it to another tenant).

---

## Validation performed (Dilux AI Studio, 2026-06-16, Postgres 17)

- **Measured:** an open transaction pins its pooled connection for its full duration
  (pool 21, `max_connections` 100).
- **Measured:** the app role is `rolsuper = f`, `rolbypassrls = f`, and cannot `CREATE` in
  `public` → search_path shadowing closed.
- **Reviewed** the design against known RLS / `SECURITY DEFINER` failure modes (sources below).

### Sources

- Cybertec — *Abusing SECURITY DEFINER functions*:
  <https://www.cybertec-postgresql.com/en/abusing-security-definer-functions/>
- Bytebase — *Postgres Row-Level Security Footguns*:
  <https://www.bytebase.com/blog/postgres-row-level-security-footguns/>
- *Why tenant context must be scoped per-transaction*:
  <https://dev.to/m_zinger_2fc60eb3f3897908/why-tenant-context-must-be-scoped-per-transaction-3aop>
