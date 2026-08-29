# Diluxite — Multi-tenancy model

How a single Postgres instance can host many organisations safely.

## TL;DR

- Diluxite uses **shared-schema, tenant-column** multi-tenancy on top of a single Postgres database. Every tenant-scoped table carries an `org_id` or `space_id`. The data model is in `packages/db/src/schema.ts`.
- Tenant isolation is enforced **today by the application layer**: every handler
  that touches a workspace or an organisation goes through one door
  (`packages/core/src/space-authz.ts`, `requireOrgRole` / `requireWorkspaceRole`),
  and the repositories always scope by `space_id` / `org_id`. REST, MCP and the
  collab WebSocket share that door — they used to disagree, and that was a bug.
  The guarantee is exercised end to end in
  `apps/api/src/cross-org-isolation.integration.test.ts`: a **super_admin of
  another organisation** — the most privileged account a tenant can hold — is
  refused on every tenant-scoped route, and a test compares that list against
  the app's own route table so a new route cannot ship unaudited.
- A **second layer is built but not engaged**. The Row-Level Security policies
  in migration `0003` are complete and proven correct in
  `packages/db/src/rls.integration.test.ts`, but the shipped API connects as a
  role with `BYPASSRLS` and never publishes `app.current_user_id`, so Postgres
  never applies them at runtime. Read [Engaging RLS](#engaging-rls-the-second-layer)
  before assuming defence in depth: today there is one layer, and it is a good
  one, but it is one.

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

Migrations and `ensureSingleUserBootstrap` need to write rows before any
membership exists, so they need a role with `BYPASSRLS`. Today the API uses
that role for *everything*, which is the reason the policies never run — see
below.

## Engaging RLS: the second layer

What the policies would give, once engaged:

- A buggy `WHERE` in a repository could not leak data: the policy still filters.
- Direct DB access — a scripted backfill, a query in a notebook, a new tool
  written without going through the right repository — would still be gated.
- No standing "remember to include `space_id` in this join" obligation.

Why it is not on yet, and what switching it on costs. Each of these is a real
piece of work, not a flag:

1. **A second Postgres role.** The API connects as the database owner, which
   the container image creates as a superuser. Superusers and `BYPASSRLS`
   roles are exempt from RLS *even with* `FORCE ROW LEVEL SECURITY`, so the
   policies are inert no matter what the application does. Engaging them means
   a `diluxite_app` role with no superuser and no `BYPASSRLS`, the owner role
   kept for migrations and bootstrap, and both wired through the installer and
   the upgrade path of existing installations.
2. **Publishing the identity on every request.** `withIdentity` exists and is
   unused. Every repository call that touches a tenant table has to run inside
   it, which means threading a transaction through the service layer — the
   part that is genuinely invasive.
3. **Three tables have RLS enabled with no policy**, which is deny-all:
   `oidc_ceremonies`, `password_resets`, `webauthn_challenges`. Correct for
   ephemeral auth rows written before anyone is authenticated, and harmless
   while the app bypasses RLS — but the moment it stops, those flows break
   unless they keep a privileged path. `users` carries no RLS at all, being
   global by design.
4. **A test that proves it is on.** The current RLS suite creates its own
   unprivileged role to exercise the policies, which proves the *policies* are
   right and says nothing about the *application*. The suite that matters
   afterwards is one that asserts the API's own connection cannot read another
   tenant's rows with the guards removed.

Until then, treat the application layer as the isolation boundary — and note
that this is also where most shared-schema products actually sit.

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

- **Planner cost**: RLS rewrites the query as `… WHERE …existing… AND policy_predicate`. The policy joins to a small indexed table (`memberships`); the cost is real but small, and it is paid only once the layer is engaged.
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
