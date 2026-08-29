# ADR-002 — Provenance, validity and rank: three standard axes, and decay that is measured rather than declared

- **Status:** accepted
- **Date:** 2026-08-29
- **Builds on:** [ADR-001](./adr-001-retrieval-architecture.md), whose step 1
  ("provenance + as-of on everything indexed") this decision specifies.

## Context

ADR-001 settled that no value leaves the system without the date it was true,
and that the work order starts there. It did not say what is stored, in what
shape, or how "old" is decided.

The first attempt at this document proposed a taxonomy: four classes of
knowledge (decision / definition / practice / pointer), each with its own
expiry rule, plus a four-rung confidence ladder. Two problems, and the second
is why this document exists.

The taxonomy was **borrowed from a workflow**. It came out of the document
kinds a methodology happens to produce, and Diluxite has to serve personal
notes, a team wiki, product documentation and whatever gets connected next. A
model shaped around one way of working stops fitting on the second use case.

And it asked the wrong question. Deciding a class means **declaring** how fast
something goes stale. That is knowable from evidence, and asking a person — or
a model — to assert it is choosing the least reliable source available.

### What the field already answers

Checked 2026-08-29; sources at the end.

**Decay is measured, not categorised.** *Not All Memories Age the Same*
(2026) estimates decay rates per fact and per relation by Bayesian inference
over observed history, exponential in form, and recovers the variation
automatically — transient facts decay fast, structural ones slowly — with no
hand-authored categories. The related line on outdated-fact filtering in
temporal knowledge graphs (HALO) works the same way.

The empirical case against a taxonomy is stronger still. Measured on
Wikipedia: the **lead sentence** of an article has a median shelf life of
**46 days**; **infobox fields** — the structured ones — sit at **3,740 days**.
Two orders of magnitude, inside one corpus, on the same topics. What predicts
the difference is not subject matter, it is **structure**. Any taxonomy of
topics would have grouped these together and been wrong about both.

**The metadata is standardised, twice.** [W3C PROV-O](https://www.w3.org/TR/prov-o/)
has been a Recommendation since 2013: `Entity`, `Activity`, `Agent`, with
`wasAttributedTo`, `wasGeneratedBy` and `wasDerivedFrom`. That is "where did
this come from and who is behind it", with an interoperable vocabulary instead
of invented columns. And **SQL:2011** standardises the two time axes —
*valid time* (true in the world) and *transaction time* (known to the system)
— as application-time period tables and system-versioned tables.

**Supersession is solved, at scale.** [Wikidata ranks](https://www.wikidata.org/wiki/Help:Ranking)
are three values: `preferred`, `normal`, `deprecated`. `deprecated` means
precisely "superseded, or now known to be wrong" and the statement is **kept**,
not deleted, across hundreds of millions of statements.

**"Confidence" as a single ladder is not a standard.** What is standard are
orthogonal *dimensions* — DAMA's six, and ISO/IEC 25012, which names
*credibility*, *currentness* and *traceability* separately. Collapsing those
into one rung number destroys information the dimensions exist to keep apart.

## Decision

### 1. Three orthogonal axes, each from an existing standard

| Axis | Standard | What it records |
|---|---|---|
| **Where it came from** | W3C PROV-O | origin note and line, the agent (person or process) it is attributed to, what it was derived from |
| **When it was true** | SQL:2011 bitemporal | `valid_from` / `valid_to`, plus `recorded_at` — the world's timeline and ours, separately |
| **Whether it still stands** | Wikidata ranks | `preferred` · `normal` · `deprecated` |

They are orthogonal on purpose. A fact can be well-sourced and out of date; it
can be current and unattributed; it can be superseded and still the right
answer to "what did we believe in March?". One number cannot carry that, which
is the mistake the confidence ladder was making.

**Two timestamps, not one.** Without the second, the only answerable question
is "what is true now". With it, "what did we believe when we made that
decision" is answerable too — and that is the question that arrives after a
decision goes wrong.

**Superseded closes, never deletes.** Setting `valid_to` and dropping the rank
to `deprecated` keeps the window in which it was true.

### 2. No classes. Decay is estimated from observed change.

Nothing is labelled. Each item carries a running estimate of how often it
actually changes, taken from its own edit history — which
`note_versions` (migration 0023) has been recording since it shipped.

Maintained incrementally, on save:

```
last_changed_at   timestamptz
change_count      int
avg_interval      interval     -- exponentially weighted moving average
first_seen_at     timestamptz
```

```
interval     = now - last_changed_at
avg_interval = α·interval + (1-α)·avg_interval
```

Constant time, constant space per item. **There is no scheduled job and no
pass over the corpus** — the estimate updates on the row being written, and
staleness is a subtraction at query time over the handful of results actually
returned. At 500k notes this is ~20 MB and no global operation, ever. A
nightly recompute is the design being rejected here, not a later optimisation.

**Cold start** uses a prior derived from **structure, not topic**, which is
what the Wikipedia measurement says predicts shelf life: a table cell behaves
like an infobox field, a paragraph like a lead sentence. No computation, and
it is replaced by evidence as soon as evidence exists.

### 3. The axes attach to an Entity, whatever an Entity currently is

Today the finest thing Diluxite has is a note, so a note is the Entity. When
`query_facts` lands (ADR-001 step 2) a table row becomes one, inheriting its
note's values and then moving on its own evidence — **in both directions**: up
when a check against the source agrees, and **down when it diverges**. The
downward move is the half that matters and the half most systems omit; it is
what lets a stored number lose authority without anyone noticing it should.

Because PROV-O attaches to an Entity rather than to a file, this is the same
schema at both granularities. No migration is deferred by starting at the note.

### 4. Arithmetic where arithmetic suffices

A model is used where it is irreplaceable: understanding a question in natural
language, and finding things by meaning. Nowhere else.

When something changed, who wrote it, whether it still stands, how old it is —
these are counts and dates. Putting a model there trades a deterministic,
auditable, free answer for a plausible, unexplainable, metered one. The system
must be able to answer *"why do you say this is stale?"* with **"you changed
this note six times in six months and have not touched it in four"**, which is
a fact, not a judgement.

## Consequences

**What this buys.** No taxonomy to invent, maintain, or migrate when a new use
case arrives. Nothing for a user to declare in frontmatter, and therefore
nothing to rot when the note changes and the label does not. Not tied to any
methodology — personal notes, a team wiki and a connected tracker are the same
shape. And the ideas are load-bearing elsewhere, so the risk is other people's
production, not this repository's design taste.

**What it costs.**

- Three axes are more schema than one confidence column, and every write path
  and API response has to carry them. Retrofitting later is the expensive
  order, which is why ADR-001 put this first.
- The estimate is only as good as the history, and history accrues at the
  speed the corpus is edited. A quiet vault stays on its structural prior for
  a long time. This is a real limitation and the reason to start recording now
  rather than when the feature is wanted.
- PROV-O is a vocabulary, not a library. Adopting the *names* and the *shape*
  buys interoperability and prior art; adopting a full RDF stack is not
  proposed and would be a poor fit for a Postgres application.
- An EWMA answers "how often does this change", not "is this specific claim
  still true". Anchoring a value against its source is a different mechanism
  (ADR-001 step 3) and is not solved here.

**Explicitly not doing.** Knowledge classes or document types as a data model.
A single confidence score. A scheduled job that walks the corpus. Deleting
superseded values. A model in the staleness path.

## Sources

Checked 2026-08-29.

- [PROV-O: The PROV Ontology (W3C Recommendation)](https://www.w3.org/TR/prov-o/)
- [Wikidata — Help:Ranking](https://www.wikidata.org/wiki/Help:Ranking) · [Help:Deprecation](https://www.wikidata.org/wiki/Help:Deprecation)
- [Temporal database / bitemporal modelling, SQL:2011](https://en.wikipedia.org/wiki/Bitemporal) · [SQL2011Temporal (PostgreSQL wiki)](https://wiki.postgresql.org/wiki/SQL2011Temporal)
- [Not All Memories Age the Same: Autodiscovery of Adaptive Decay in Knowledge Graphs](https://arxiv.org/pdf/2604.26970)
- [HALO: Half Life-Based Outdated Fact Filtering in Temporal Knowledge Graphs](https://arxiv.org/pdf/2505.07509)
- [Half-life of knowledge](https://en.wikipedia.org/wiki/Half-life_of_knowledge)
- [Risk-Constrained Freshness-Aware Semantic Caching for Open-Web Retrieval-Augmented LLMs](https://arxiv.org/pdf/2607.04281) — freshness classes
- [ISO 8000 / ISO-IEC 25012 data quality dimensions](https://quality.arc42.org/standards/iso-8000) · [DAMA six dimensions](https://dataworkers.io/resources/data-quality-dimensions/)
