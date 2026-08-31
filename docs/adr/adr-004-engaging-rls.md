# ADR-004 — Engaging Row-Level Security: two planes, and a scope that never holds a connection

- **Status:** accepted
- **Date:** 2026-08-30
- **Relates to:** [MULTI-TENANT.md](../MULTI-TENANT.md), whose "Engaging RLS"
  section this decision resolves, and [ADR-003](./adr-003-embedding-model-lifecycle.md)
  (whose tables inherit the same policies).

## Context

Diluxite hosts several organisations in one installation, and today exactly one
thing keeps them apart: the application asks `space-authz` before every read and
write. That layer is real — one door shared by REST, MCP and collab, exercised
against a org_admin of another organisation on every tenant-scoped route in
`cross-org-isolation.integration.test.ts`, with a guard that fails the suite
when a new route appears unaudited.

It is also **one** layer. The Row-Level Security policies written in migration
`0003` were documented as a second, independent one and are not: the API
connects as the container image's superuser — exempt from RLS even with `FORCE
ROW LEVEL SECURITY` — and `withIdentity`, the helper that would publish
`app.current_user_id`, is never called. Verified against the running database:
as the API's own role, with no identity published, `SELECT count(*) FROM notes`
returns every row where the policies would return none.

What engaging them buys is narrow and worth stating exactly: a route that
forgets its guard, a query written by hand, a repository whose `WHERE` drifts —
none of those become a cross-tenant leak. It does not make the application
layer redundant; it makes a mistake in it survivable.

## Two discoveries that shape the design

### 1. The authentication plane cannot run under RLS

The policies on the auth tables are circular by nature:

| Table | Policy | Why it cannot gate authentication |
|---|---|---|
| `tokens` | `user_id = diluxite_current_user_id()` | resolving a Bearer token means reading this table **before** the user is known |
| `sessions` | same | login writes the session that establishes the identity |
| `passkeys`, `totp_secrets` | same | the credential must be found before its owner is |
| `oidc_ceremonies`, `password_resets`, `webauthn_challenges` | none | RLS enabled with no policy is deny-all |

Loosening those policies would be the wrong answer: they are correct for what
they gate, which is one user reading another user's credentials. The right
answer is that **authentication is infrastructure, not tenant data**, and runs
privileged. The seam already exists — the `preHandler` that resolves
`req.identity`. Before it, privileged; after it, scoped.

This bounds the guarantee honestly: RLS protects the **data plane**. The auth
plane stays protected by code alone.

### 2. The scope must not span a call to an embedding model

Diluxite calls an embedding model on every save and every semantic search —
100 ms to 2 s against Ollama or Azure. The pool holds ten connections. A scope
that lasts the whole request holds one of them idle while the model answers, so
eleven concurrent searches stall the instance. The same is true of a reserved
connection: it is the holding that hurts, not the transaction.

So the scope is opened **per repository method** and closed with it. The
embedder call happens in the service layer, between repository calls, outside
any scope. Measured: +2.4 ms per scoped operation, against the 100–2000 ms the
model costs — and zero connections in `idle in transaction` while a simulated
model call runs.

## Decision

**Two planes, and a scope per unit of database work.**

1. **No new credentials.** The connection stays as it is; each scoped operation
   drops privileges with `SET LOCAL ROLE diluxite_app`, which reverts at commit.
   The migration creates the role and `GRANT`s it to the connecting user, so
   installations that connect as a non-superuser owner work too — verified.
   `install.sh`, compose and existing deployments are untouched beyond running
   the migration.

2. **The identity travels in `AsyncLocalStorage`**, set once after the identity
   preHandler. Two proxies do the rest, in one place:
   - the database handle the repositories receive resolves to the scope's
     transaction when there is one, and to the pool otherwise;
   - each repository method, when a scope is active and no transaction is open,
     opens one, sets the role and the identity, and runs the method inside.

   The twenty repositories and every route handler are unchanged. That is the
   point: a mechanism nobody has to remember is the only kind that survives.

3. **Outside a scope means privileged**, which is what migrations, the
   single-user bootstrap, the seed and the auth routes need — and is why the
   test in §4 matters.

## Consequences

- A missing guard stops being a leak. The application layer keeps its job; RLS
  catches what it drops.
- Every scoped operation costs one extra round trip pair. Measured at +2.4 ms
  locally.
- Three auth tables stay deny-all and are only ever touched privileged. If a
  future data-plane feature needs them, it needs a policy first.
- The failure mode of getting this wrong is **silent**: an instance that never
  enters the scope behaves exactly like today. Hence:

### 4. The test that proves it is on

Not "the policies are correct" — `rls.integration.test.ts` already proves that,
against a role it creates itself, which says nothing about the application. The
test that matters asserts that **the API's own connection, inside a request,
cannot read another tenant's rows with the code guards removed**. If that test
can be made to pass with RLS disengaged, it is not testing anything.

## Alternatives considered

- **Request-scoped transaction.** Simplest, and holds a pooled connection
  across every embedding call. Rejected on the measurement above.
- **A reserved connection per request** (`sql.reserve()`). Same holding problem,
  and drizzle cannot wrap a reserved connection — it reads `.options.parsers`
  off the client, which a reservation does not carry. Tried; it throws.
- **A second database user in the connection string.** Rejected once
  `SET LOCAL ROLE` was verified from a non-superuser owner: a second credential
  buys nothing and costs an upgrade path for every existing installation.
- **Loosening the auth policies so everything can run scoped.** Rejected: those
  policies are right, and the circularity is inherent, not incidental.
