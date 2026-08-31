# ADR-005 — Who owns the installation, and what each organisation chooses

- **Status:** accepted
- **Date:** 2026-08-31
- **Amends:** [ADR-003](./adr-003-embedding-model-lifecycle.md), whose
  "one live model per installation" becomes "one live model per organisation".
- **Builds on:** [ADR-004](./adr-004-engaging-rls.md) (the isolation this relies
  on) and [MULTI-TENANT.md](../MULTI-TENANT.md).

## Context

Two questions turned out to be the same question.

The first came from the admin console: the embedding provider is
instance-wide, so its routes have no organisation to scope by, and the bar
ended up being "org_admin of any organisation". On an installation shared by
organisations that do not trust each other, one tenant's admin can change what
the others search with. There is no role above the organisation to give it to.

The second came from the product: **should each organisation choose its own
embedding provider?** ADR-003 said no — one live model per installation —
because a single vector column holds one live model and two organisations on
different models meant two live partitions. That was a design choice presented
as a constraint.

They are the same question because the answer to the second creates the first:
the moment an organisation owns its own provider, somebody has to own the
installation that hosts them.

### What the field does

Checked 2026-08-31; sources at the end. Per-tenant configuration of the
embedding model is not exotic — it is the documented pattern:

> *"Store per-tenant configuration including chunking strategy, embedding
> model, and prompt templates, and apply these at each pipeline stage."*

The isolation model Diluxite already uses — one shared store, a tenant column,
filtering enforced in the database — is the **Pool** pattern, recommended for
everything short of enterprise-scale silos. The same sources are emphatic that
isolation belongs at the store's query layer rather than in application code,
which is what ADR-004 engaged.

### Two measurements that decided the shape

**Sharing an index between tenants silently breaks the small one.** With ten
vectors belonging to org A and twenty thousand belonging to org B in the same
HNSW index, a search by A for its five nearest returns **zero**: the index
hands back its 391 nearest candidates, all of them B's, and the tenant filter
removes every one. A does not get back its own vector at distance zero.
pgvector 0.8's iterative scan pushed that to 7,931 rows examined and still
returned zero. With a partition of its own, A gets five out of five.

That is not a leak — A never sees B's data — but it is a multi-tenant defect of
the worst kind: the tenant searches, finds nothing, and nothing errors.

**Partitioning per organisation does not cost space.** HNSW is roughly linear:
2,000 vectors index to 5.9 MB, 20,000 to 125 MB. Ten organisations of 2,000
each in their own partitions come to ~59 MB against ~125 MB for the same
20,000 pooled. It is cheaper *and* correct.

### And a hole found on the way

**Postgres does not inherit RLS policies to partitions.** A policy on
`chunk_embeddings` protects a query that goes through the parent and does
nothing for one that names the partition: measured at 0 rows against 58. Only
privileged code names partitions today, but "nothing does yet" is not a
security property. Every partition now carries its own policy.

## Decision

### 1. Three roles, and one of them is not about an organisation

| Role | Scope | Can |
|---|---|---|
| `setup_admin` | the **installation** | create organisations, instance-wide settings, promote another setup_admin |
| `org_admin` | one organisation | everything inside it: members, workspaces, its embedding provider, delete it |
| `org_member` | one organisation | ordinary access; a workspace still needs its own membership row |

This replaces `org_admin` / `admin` / `member`. It is not a fourth level: the
old `org_admin` and `admin` differed only in "may delete the org" and "may
demote the owner", which is a distinction worth losing.

`setup_admin` lives on the user, not in `org_memberships`, because it is not
about an organisation.

**A setup_admin is not a god over tenant data.** They administer the
installation; reading an organisation's notes still requires membership in it.
That is deliberate and tested: an operator who can host tenants is not thereby
entitled to read them.

### 2. Each organisation chooses its own embedding provider

`embedding_config` becomes per organisation. The catalogue keeps one **live
model per organisation** rather than per installation, and the vectors are
partitioned by `(organisation, model)` — so:

- two organisations on the same model still get **separate partitions**, which
  is what keeps the small one's search working;
- an organisation changing its model has two partitions for the duration of
  the change and one again afterwards, exactly as ADR-003 described, now
  scoped to that organisation;
- retiring is still `DROP TABLE` on a partition: instant, nothing left behind.

Steady state: **one partition per organisation**. Postgres is comfortable with
hundreds; an installation with thousands of tenants wants a different topology
and is out of scope for Core.

## Consequences

- A tenant's search quality no longer depends on how much data its neighbours
  have. That was the practical reason to do this, more than provider choice.
- Isolation gains a **physical** dimension on top of the row filter: a tenant's
  vectors live in their own table. Belt and braces, and the braces are new.
- More partitions and more indexes. Measured as cheaper than pooling, but the
  count grows with tenants, and the reindex after a model change is now per
  organisation — which is an improvement: one tenant rebuilds without touching
  another.
- `setup_admin` is a new kind of account. An installation that never has a
  second organisation never notices it exists.

## What this does not decide

Whether a `setup_admin` should be able to *grant themselves* membership in a
tenant's organisation. Today they cannot, and that is the safer default; an
operator who needs to support a customer can be invited like anyone else, which
leaves an audit trail. Revisit when a support workflow actually asks for it.

## Sources

- [Multi-Tenant RAG in 2026 — Mavic Labs](https://www.maviklabs.com/blog/multi-tenant-rag-2026)
- [Multi-Tenant RAG Data Isolation — Truto](https://truto.one/blog/how-to-architect-strict-data-isolation-in-multi-tenant-rag-pipelines/)
- [Silo, Pool, and Bridge for Multi-Tenant RAG](https://www.ijetcsit.org/index.php/ijetcsit/article/download/551/493)
- [Multi-Tenancy and Managing Multiple RAG Instances — apxml](https://apxml.com/courses/optimizing-rag-for-production/chapter-7-rag-scalability-reliability-maintainability/rag-multi-tenancy-management)

## Measurements

Taken 2026-08-31, Postgres 17 + pgvector 0.8.6, 1024-dimension vectors:

| | Result |
|---|---|
| Org A (10 vectors) searching a pooled index shared with org B (20,000) | **0 of 5 returned**; 391 candidates, all B's, all filtered out |
| Same, with `hnsw.iterative_scan = relaxed_order`, `max_scan_tuples = 100000` | **0 of 5**; 7,931 rows examined |
| Org A searching its own partition | **5 of 5** |
| HNSW index, 2,000 vectors | 5.9 MB |
| HNSW index, 20,000 vectors | 125 MB |
| RLS on a partition, queried through the parent / by name (before the fix) | 0 rows / 58 rows |
| Same, after giving the partition its own policy | 0 rows / 0 rows |
