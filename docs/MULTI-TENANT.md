# Diluxite — Multi-tenancy model

How a single Postgres instance can host many organisations safely.

## TL;DR

- Diluxite uses **shared-schema, tenant-column** multi-tenancy on top of a single Postgres database. Every tenant-scoped table carries an `org_id` or `space_id`. The data model is in `packages/db/src/schema.ts`.
- Tenant isolation is enforced in **two layers**, and both of them run.
  1. **Application** — every handler that touches a workspace or an
     organisation goes through one door (`packages/core/src/space-authz.ts`),
     shared by REST, MCP and the collab WebSocket. Exercised against a
     **super_admin of another organisation** on every tenant-scoped route in
     `apps/api/src/cross-org-isolation.integration.test.ts`, with a guard that
     fails the suite when a new route ships unaudited.
  2. **Database** — Postgres Row-Level Security. The data plane of every
     request runs as `diluxite_app`, a role with no superuser and no
     `BYPASSRLS`, with `app.current_user_id` published, so the policies from
     migration `0003` refuse cross-tenant rows on their own. See
     [ADR-004](./adr/adr-004-engaging-rls.md) for how, and what it cost.
- The two are independent, and that is measured rather than asserted:
  `apps/api/src/rls-enforced.integration.test.ts` mocks the application guards
  **open** and shows that a second organisation still reads nothing — through
  REST, through search, through the export, and through MCP.
- **Authentication runs privileged, by necessity.** Resolving a Bearer token
  means reading `tokens`, whose policy asks who the user is; gating that with
  RLS is circular. Login, password reset, passkeys, OIDC and TOTP are the auth
  plane and are protected by code alone. So is the collab write path, for a
  different reason — see ADR-004.

## Why we picked this

We considered three flavours of multi-tenancy:

| Approach | Isolation | Ops cost | Postgres feature set | pgvector across tenants | Fit |
|---|---|---|---|---|---|
| Database-per-tenant | Strongest | Very high (a DB per org) | Full | Per-DB indexes | ❌ Doesn't scale to thousands of orgs in Cloud. |
| Schema-per-tenant | Strong | High (a schema per org, hard migrations) | Full | Per-schema | ❌ Same migration runbook breaks fast. |
| **Shared-schema + tenant column + RLS** | Strong (with RLS) | Low | Full + RLS | One index, queryable across tenants when allowed | ✅ |

The shared-schema model is what Linear, Notion, Vercel, GitHub and Supabase use under the hood, and it's the one Postgres is *designed* for via RLS.

## What's tenant-scoped

| Tier | Owner column | Tables that carry it |
|---|---|---|
| Organisation | `org_id` | `organizations` (id), `org_memberships`, `spaces.org_id` |
| Workspace (space) | `space_id` | `spaces` (id), `memberships`, `notes`, `folders`, `note_tags`, `note_links`, `chunks` |
| User | `user_id` | `tokens`, `org_memberships`, `memberships`, `spaces.owner_id` |

Untenanted (shared, public-ish) tables: `users` (an email address is a person, identified across orgs by their email).

## RLS policies (migration `0003_row_level_security.sql`)

Each tenant-scoped table has RLS enabled and a single `USING / WITH CHECK` policy that joins to `memberships` / `org_memberships`:

- `spaces`: a row is visible iff the current user has a `memberships` row in that space, **or** is `super_admin` / `admin` in the space's org.
- `notes`, `folders`, `chunks`, `note_tags`, `note_links`: same predicate, joined via `space_id`.
- `org_memberships`: visible iff the user is *any* member of that org.
- `memberships`: visible iff the user can see the parent space.
- `tokens`: a row is visible only to its owner (`user_id = current_user_id`).

How the per-request user identity reaches the database:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL app.current_user_id = ${userId}::text`);
  // …all subsequent queries inside the transaction see only this user's rows
});
```

The helper lives in `packages/db/src/with-identity.ts`. **Nothing in the API
calls it yet** — it is the piece that would engage the policies, not a
description of what runs today.

### "Bypass" for the bootstrap / migrations

Migrations, `ensureSingleUserBootstrap`, the seed and the auth plane run
outside the scope, on the connection's own role. Everything else — every
repository call made while a request has an identity — runs as
`diluxite_app`.

## How the second layer runs

Three decisions, all in [ADR-004](./adr/adr-004-engaging-rls.md):

- **No new credentials.** The connection is unchanged; each scoped operation
  drops privileges with `SET LOCAL ROLE diluxite_app`, which reverts at commit.
  Migration `0028` creates the role and grants it to whoever the application
  connects as, so a hardened install that connects as a plain owner works too.
  `install.sh`, compose and existing deployments need nothing but the
  migration.
- **The scope is per repository method, not per request.** Diluxite calls an
  embedding model on every save and every semantic search — 100 ms to 2 s —
  and a request-long scope would park one of ten pooled connections for the
  duration. Measured: +2.4 ms per scoped operation, and zero connections left
  `idle in transaction` while a model call runs.
- **Nobody has to remember it.** An `AsyncLocalStorage` scope opened at the
  start of each request, and two proxies: the handle the repositories hold
  resolves to the scope's transaction, and each repository method opens one
  when a scope is active. The twenty repositories and every route handler are
  unchanged.

If the role cannot be assumed — an installation whose migration has not run —
the API says so at boot rather than silently falling back to one layer.

## Known limitation: the shared `users` table

One account can belong to several organisations, so `users` is global and is
the one tenant-adjacent table with no RLS. The CSV import
(`POST /api/admin/orgs/:orgId/users/import-csv`) upserts by email, which means
an admin of org B **can rewrite the first and last name** of a person who
belongs to org A.

The bound is measured, not assumed — `cross-org-isolation.integration.test.ts`
asserts exactly this and asserts everything that does NOT move with it: the
password hash, the active flag, the account id, and the memberships. It grants
no access: the same caller is still refused org A's notes on the next request.

The fix is to scope the import to emails already in the caller's organisation
(plus genuinely new ones), which is what an invite already does. Small, and on
the roadmap.

## Trade-offs

- **Cost**: RLS rewrites each query as `… WHERE …existing… AND policy_predicate`, joining a small indexed table (`memberships`), and each scoped operation adds a transaction. Measured together at **+2.4 ms per repository call** — against the 100–2000 ms an embedding model costs on the paths that have one.
- **Connection pool reuse**: `SET LOCAL` resets at transaction commit, so a pooled connection cannot bleed identity across requests. `SET` (global) would be unsafe here — `SET LOCAL` is the right primitive, and it is what `withIdentity` uses.

## Future work

- **RLS for the embeddings pipeline**: the deterministic embedder is pure, but the Azure provider talks to an external service. We deliberately compute and persist embeddings client-side; the RLS-enabled `chunks` table still only returns rows for the right tenant.
- **Hard tenant deletion**: today `DELETE org_id` cascades through the schema. We should also issue a tombstone event so derived stores (search caches, MCP token revocations) sync.
- **RLS on `audit_events`**: the policy shipped (migration `0019`); like every
  other policy it waits on the two items above to actually run.
- **Bulk delete answers 200 to a caller it refused.** `POST /api/notes/delete-many`
  authorises each id individually and drops the ones the caller cannot touch,
  so nothing leaks and nothing is deleted — but the response is
  `200 {deleted: 0}`, which a caller cannot tell apart from "there was nothing
  to delete". Pinned by a test; worth a distinct status.

## References

- [Postgres docs — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Supabase architecture — RLS for SaaS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [PostgresWeekly — `SET LOCAL` vs `SET`](https://www.postgresql.org/docs/current/sql-set.html#:~:text=SET%20LOCAL)
