# Validity, expiry and rank — the surfaces

**Status:** proposal, nothing built. Companion to
[ADR-002](./adr/adr-002-knowledge-model.md), which decided the *model*: three
orthogonal axes (PROV-O provenance · SQL:2011 bitemporal validity · Wikidata
ranks) and decay estimated from observed change rather than declared.

ADR-002 stops at the schema. This document answers the question it left open,
which is the one a person actually asks: **who decides that something expired,
where do they say so, and how does any of it reach the ranking?**

## The starting point: what is measured, what is declared, what is configured

The distinction that organises everything below. Getting it wrong is how
products end up with a taxonomy nobody maintains.

| | Who sets it | Where it is touched | Today |
|---|---|---|---|
| **Ageing** — how fast this note actually changes | Nobody. Taken from the note's own edit history | Nowhere, and that is correct | ✅ works |
| **"This no longer holds"** — superseded | A person, or the AI over MCP | A button on the note + an MCP tool | ❌ `supersede()` exists, tested, **and has no caller** |
| **A date the world imposes** — a contract ends 31-Dec | A person, note by note | A field in the note's info panel; carried in frontmatter | ❌ does not exist |
| **How much each of those weighs in the order** | The organisation, once | One admin screen | ❌ does not exist |

The first row is the heart of ADR-002 and is deliberately not configurable.
There is no screen where somebody declares "prices expire after 30 days,
decisions never": that taxonomy is invented once and rots quietly. The
criterion is the note's own measured rhythm, and the system can state it in
words — *"you changed this six times in six months and have not touched it in
four"* — which is a count, not a judgement.

The other three rows are where a human decision is unavoidable, and each one
needs a surface. There are exactly three.

## Surface 1 — the note's info panel

An ⓘ in the note's title bar, next to the freshness badge that already ships.
It renders the three axes as a sentence, not as fields:

> Written by Pablo, through the app, on 12 Aug · Valid since 12 Aug, no expiry
> · Still holds · Usually changes every ~40 days; untouched for 4 months.

Two actions live there, and they are the only way `valid_to` and `rank` ever
get written:

- **"This no longer holds"** → calls `supersede()`: closes the validity window
  and drops the rank to `deprecated`. The row stays — that is the whole point
  of the rank. What was true in March is still answerable.
- **"Set an expiry date"** → writes `valid_to` in the future. This is the case
  ageing *cannot* measure, because it has nothing to do with how often the note
  is edited: a contract, a rotating credential, a quarterly budget.

The same two actions become MCP tools, so the AI that notices a fact went stale
can mark it without a person in the loop. That is the point of the product.

## Surface 2 — Admin → Search, three knobs

The screen already exists (search mode + topK, persisted per organisation in
`org_settings`, readable by any member, writable by an admin, audited). It
grows:

| Knob | What it does | Suggested default |
|---|---|---|
| Weight of **out of its rhythm** | How far a note past its own cadence drops | mild — today it only warns, it does not drop at all |
| Weight of **expired / superseded** | How far a note whose window closed drops | strong |
| **Expired notes: show marked, or hide** | The same decision archive already took | show marked |

Three numbers and a checkbox — the whole configuration surface for this line.
They are per organisation because the criterion genuinely differs between a
company and one person's second brain, unlike the ageing estimate, which is
per note and needs nobody's opinion.

Two rules the implementation must keep:

- **Everything stays explainable.** Any result that moved must be able to say
  why in one sentence built from dates and counts. No model decides ranking.
- **Nothing disappears silently.** The default is to answer and mark, never to
  hide — the lesson archive already settled: in a memory for an AI, what search
  cannot reach has been forgotten, not filed.

## Surface 3 — the frontmatter carries it

The Markdown export already writes `id`, `title`, `created`, `updated` and
`favorite` as YAML frontmatter, and the import reads it back. `valid_to` and
`rank` join them, so expiry travels with the file instead of dying inside the
database — provider-agnostic, like everything else on this line.

## What is deliberately not built

- Policies per content type, or any screen that classifies notes into kinds.
- A model deciding whether something is stale, or how much it should drop.
  When something changed, who wrote it, whether it still holds, how old it is:
  these are dates and counts. A model there trades a deterministic, auditable,
  free answer for a plausible, unexplainable, metered one.
- A scheduled job that walks the corpus. Staleness is a subtraction at query
  time over the handful of results being returned, and that is a hard
  constraint from ADR-002, not an optimisation.

## Surface 4 — the curation queue and the weekly batch

This one does not come from ADR-002. It comes from
**"Company Brain — modo funcional" (2026-08-28)**, and it is the half that
document got right and the ADR never picked up.

That document's proposal, in one line: knowledge lands in a **capture layer**
automatically, and only what passes review reaches a **curated layer**; an
agent proposes what deserves to be promoted, with its citation, and a domain
owner approves or rejects it in a **fifteen-minute weekly batch**.

**The part ADR-002 deliberately rejected, and why.** That document graded
everything on a single ladder (N0 inferred → N1 captured → N2 confirmed → N3
verified → Core). ADR-002 replaced the single number with three orthogonal
axes, because one number cannot hold three independent facts: something can be
well-sourced and out of date, current and unattributed, superseded and still
the right answer to "what did we believe in March". That correction stands.

**The part that was not rejected, and is simply missing.** The *ritual* is
orthogonal to the model, and nothing in the schema replaces it. The ladder's
levels map cleanly onto what already exists:

| Company Brain | How it is stored here |
|---|---|
| N0 · inferred, N1 · captured | `rank: normal`, provenance `agentKind` says which door it came through |
| N2 · confirmed (sources agree) | a confirmation renews the cadence estimate at no human cost — the ageing machinery already does this |
| N3 · verified (an owner signed it) | `rank: preferred` + PROV-O `attributedTo` = who signed |
| Core (leadership) | `rank: preferred` on a small, explicitly held set |
| Superseded | `valid_to` closed + `rank: deprecated` — the row stays |

So the level is not a new column. It is a **reading** of rank plus provenance.
What is missing is everything that produces those values:

- **A promotion queue.** The agent proposes what deserves to rise, with its
  citation. Nothing proposes anything today.
- **A fixed human budget.** The owner's batch is fifteen minutes a week, and
  the system regulates its own volume against that budget: when there are more
  candidates than budget, it **raises the bar of what it proposes**, never the
  human load. This is a design constraint, not a preference.
- **Rejections are recorded with a reason, visible and appealable.** An owner
  must not be able to turn the memory into their version of events in silence.
  The audit log is already there; the queue is not.
- **Rules of use.** High-impact questions — metric definitions, regulatory
  matters, risk thresholds — are never answered from uncurated material. With
  nothing curated, the honest answer is *"I do not know this with the required
  confidence"*, plus the path to get it. This is a ranking rule with teeth, and
  it is the reason the three knobs of Surface 2 exist.
- **Change of tone when a whole area goes old.** The brain stops asserting and
  starts describing: *"the last thing recorded is X, from that date,
  unconfirmed."* Today the freshness caveat rides on one result at a time;
  this is the same idea at the level of an answer.

Two more mechanisms from that document belong to other lines and are already
scheduled: **anchoring against reality** (a metric definition checked against
what the pipeline actually computes; divergence alerts) is ADR-001's live-state
resolvers plus ADR-002's downward move, and **automatic capture at task close**
is the session-capture skill. **Meaning-collision detection** — two areas using
the same word differently, caught at save time — has no home yet and is the one
genuinely new piece.

## Order, and what it depends on

1. **Wire `supersede`** — route, the note's two actions, the MCP tools. ~1 day.
   This is the gap that matters: without it `valid_to` is never written by
   anything, and the whole validity axis is dead weight in the schema.
2. **Make rank and expiry weigh in the ranking** — the three knobs. ~½ day.
3. **The info panel** as described. ~1 day.
4. **`asOf` queries** ("what did we believe in March") and **validity at the
   fact level** — the down-move when a stored number diverges from its source.
   2-3 days, and it wants the live-state resolvers (ADR-001 step 3) first,
   because that is what supplies the source to diverge from.
5. **The curation queue and the weekly batch** (Surface 4). 3-4 days, and it is
   the piece that decides whether this is a memory that stays trustworthy or a
   landfill with a search box. It needs 1 and 2 first: without a rank that
   anybody can set and that actually weighs, promoting something changes
   nothing.

## Sources

- [ADR-001 — retrieval architecture](./adr/adr-001-retrieval-architecture.md)
- [ADR-002 — provenance, validity and rank](./adr/adr-002-knowledge-model.md)
- *Company Brain — modo funcional*, 2026-08-28 (Pablo's document; §8 the
  reliability ladder, §9 how it stays alive, §10 the leadership core)
