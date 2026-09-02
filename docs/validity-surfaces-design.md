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
What is missing is everything that produces those values.

### Where the question actually appears

One new item in the activity bar, under Archive:

```
│★ │ Favorites
│🕐│ Recent
│🗄│ Archive
│✅│ Review  (12)     ← the only new screen
│🗑│ Trash
```

It opens on a list of cards. One card is one question and three buttons:

```
┌──────────────────────────────────────────────────┐
│  Does this still hold?                           │
│                                                  │
│  «umbral_fraude = 3%»                            │
│                                                  │
│  Risk — minutes of 12 Aug · line 14              │
│  Used 9 times this month · never signed by anyone│
│                                                  │
│  [ Yes, it holds ]  [ No, it changed ]  [ Not mine ] │
└──────────────────────────────────────────────────┘
                                          1 of 12
```

Twelve cards, fifteen seconds each. That is the whole "weekly batch" — not a
meeting and not a report.

| Button | What it writes |
|---|---|
| **Yes, it holds** | `rank: preferred` + signed by that person, dated. Answers then read *"3%, verified by Pablo on 12-Sep"* |
| **No, it changed** | The new value is written; the old row's `valid_to` closes and it drops to `deprecated`. **The old row stays** — "in August we believed 3%" is still answerable |
| **Not mine** | Leaves this queue for the domain owner's |

Where the card came from, end to end: somebody wrote a plain GFM table in a
meeting note three months ago, and the fact lane derived the row at save time
(`umbral_fraude` · `valor` · `3%` · line 14) — that part ships today. On Friday
the job ranks candidates and keeps the top N. For a fact the question is a
template; **no model is involved, it is a `printf`.**

The card can also travel: the same queue over MCP, so the assistant can raise
it in conversation, or a link in a weekly mail. The screen is its home; those
are doors to it.

### The budget, as something a machine can actually enforce

"Fifteen minutes a week" is not implementable — the system cannot measure a
person's minutes. It can measure **decisions**:

```
budget_items = agreed_minutes / measured_seconds_per_decision
```

The divisor is **measured, not estimated**: the time between opening an item
and deciding it. After two or three weeks there is a real median and the
budget recalibrates itself. If decisions get slower, fewer are proposed, with
nobody adjusting anything.

What makes fifteen minutes plausible is the *shape of the question*: a
yes/no with the citation already drafted is 15-25 seconds, so ~45 decisions a
week. "Read this note and give an opinion" is three minutes, so five a week,
and the mechanism is dead. **The design of the question decides whether the
budget exists at all.**

**No backlog, ever.** With 300 candidates and a budget of 45, the other 255 are
not queued for next week: they stay in the capture layer, marked uncurated, and
compete again next week if usage makes them worth it. A queue that grows is the
failure signal, not evidence of demand. Candidates rank by expected value:
*how often it was used to answer × how long since anyone confirmed it × what
breaks if it is wrong.*

**How you know it works — three numbers, none of them declarative:**

| Measure | What it tells you | What to do when it is bad |
|---|---|---|
| % of the batch actually cleared | whether the budget is real | lower the volume, never push harder |
| Real minutes spent | whether fifteen was fifteen | recalibrate the divisor |
| **% of answers served from curated material** | the only thing the budget buys | if it does not rise, the problem is *what* is proposed, not how much |

The third is the one that matters. The first two measure effort; that one
measures result. A batch cleared 100% with a flat third number means the
curation is landing on things nobody consults.

**And when nobody does it** — which happens, and the system may neither nag nor
punish: answers degrade honestly (*"this comes from captured, uncurated
material"*), high-impact questions are refused outright, and if maintaining it
costs more than the budget the mechanism is redesigned rather than more
discipline demanded. Most items never reach a human anyway: repeated task
closes that agree with something already stored confirm it at no human cost.

### What is still missing before that card can exist

Three things, and none of them is a model:

1. **A usage counter.** Nothing records how often a note or a fact was used to
   answer. Without it the queue cannot rank by importance, which is the whole
   mechanism. Half a day.
2. **The queue** — the table, plus the job that fills it with exactly N
   candidates, N being the budget.
3. **The Review screen** above.

Then the rules that come with it:

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

### Where the agent lives, and what it is allowed to touch

Two halves, and **both from the start**:

- **Outside, over MCP.** The engine exposes the candidates; a skill in the
  client drafts proposals. This is what Diluxite already is, and it costs
  nothing.
- **Inside, an optional generation provider** per organisation, off by default
  — [ADR-006](./adr/adr-006-generation-provider.md). Needed for one operational
  reason: **the batch has to be ready on Friday whether or not anybody opened
  Claude that week.**

It is consumed in exactly one place: the job that builds the queue, once a
week, off the request path. One short call per candidate — *"from this passage,
write the one-line claim an owner can confirm with yes or no"* — and it returns
a sentence and its source line. It never decides truth, never touches ranking,
never writes to a note, and never answers a user's question.

Note the constraint this respects: ADR-002 forbids scheduled jobs that walk the
corpus, and this is not one. The job sees **at most N candidates**, already
ranked by arithmetic. If it ever needs to read the corpus, it is designed
wrong. And the spend caps itself: the weekly call count *is* the human budget,
so nothing is drafted that nobody will read.

With no provider configured, fact candidates still get their templated
questions and prose candidates are simply not proposed. Off is a working state.

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
5. **The usage counter.** ½ day, and it gates the queue: without it there is
   no way to rank candidates by importance.
6. **The curation queue, the Review screen and the weekly batch** (Surface 4).
   3-4 days. This is the piece that decides whether this stays a memory worth
   trusting or becomes a landfill with a search box. It needs 1 and 2 first:
   without a rank anybody can set, and that actually weighs, promoting
   something changes nothing.
7. **The generation provider** ([ADR-006](./adr/adr-006-generation-provider.md))
   — 1-2 days, in from the start rather than deferred, so the batch is ready on
   Friday without depending on somebody having a session open. Prose
   candidates only; facts never need it.

## Sources

- [ADR-001 — retrieval architecture](./adr/adr-001-retrieval-architecture.md)
- [ADR-002 — provenance, validity and rank](./adr/adr-002-knowledge-model.md)
- *Company Brain — modo funcional*, 2026-08-28 (Pablo's document; §8 the
  reliability ladder, §9 how it stays alive, §10 the leadership core)
