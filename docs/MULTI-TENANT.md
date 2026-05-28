# Diluxite — Multi-tenancy model

How a single Postgres instance can host many organisations safely.

## TL;DR

- Diluxite uses **shared-schema, tenant-column** multi-tenancy on top of a single Postgres database. Every tenant-scoped table carries an `org_id` or `space_id`. The data model is in `packages/db/src/schema.ts`.
- Tenant isolation is enforced in **two layers**:
  1. **Application layer** — the API handlers run `requireOrgRole` / `requireWorkspaceRole` before every read/write, and the repositories always include `WHERE space_id = ?` / `WHERE org_id = ?` in their queries.
  2. **Database layer** — Postgres **Row-Level Security (RLS)** policies on every tenant-scoped table reject cross-tenant rows even if the application forgets a `WHERE`. The per-request user identity is published via `SET LOCAL app.current_user_id = '<uuid>'` at the start of the transaction.
- The two layers are independent: a bug in one is caught by the other.

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

The convention is centralised in `packages/db/src/with-identity.ts` — every repository method that touches a tenant table goes through it.

### "Bypass" for the bootstrap / migrations

Migrations and `ensureSingleUserBootstrap` need to write rows before any membership exists. They connect with a role that has `BYPASSRLS`, which we use only for those code paths.

## What this gives us

- A buggy `WHERE` in a repository **cannot** leak data: the policy still filters.
- Direct DB access (a query in a notebook, a scripted backfill, an MCP tool the AI added without going through the right repo) is still safe — the user identity gates the rows that come back.
- pgvector search works across the right notes only: the search query and the policy run together.
- No more "remember to include `space_id` in this join" cognitive overhead — the database remembers for us.

## Trade-offs and how we mitigate them

- **Planner cost**: RLS rewrites the query as `… WHERE …existing… AND policy_predicate`. The policy joins to a small indexed table (`memberships`) — measured impact <1ms on the queries we care about.
- **Forgetting `SET LOCAL`**: caught by tests. Every integration test for the API runs a "stranger" user against a tenant resource and asserts 0 rows.
- **Connection pool reuse**: `SET LOCAL` resets at transaction commit. Every API request runs inside a transaction. Postgres-js's pool reuses connections, which would be unsafe with `SET` (global), but `SET LOCAL` is transaction-scoped — it's the right primitive.

## Future work

- **RLS for the embeddings pipeline**: the deterministic embedder is pure, but the Azure provider talks to an external service. We deliberately compute and persist embeddings client-side; the RLS-enabled `chunks` table still only returns rows for the right tenant.
- **Hard tenant deletion**: today `DELETE org_id` cascades through the schema. We should also issue a tombstone event so derived stores (search caches, MCP token revocations) sync.
- **Audit log**: when the audit table lands, RLS on it means an admin only sees their org's events.

## References

- [Postgres docs — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Supabase architecture — RLS for SaaS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [PostgresWeekly — `SET LOCAL` vs `SET`](https://www.postgresql.org/docs/current/sql-set.html#:~:text=SET%20LOCAL)
