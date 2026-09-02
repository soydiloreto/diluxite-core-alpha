# ADR-006 — A generation provider, for drafting only

- **Status:** accepted
- **Date:** 2026-09-02
- **Relates to:** [ADR-002](./adr-002-knowledge-model.md) (the axes this fills
  in), [ADR-003](./adr-003-embedding-model-lifecycle.md) (the provider shape
  this copies) and
  [validity-surfaces-design.md](../validity-surfaces-design.md) (the surfaces
  that consume it).

## Context

Until now Diluxite has had **no generative model anywhere**. It embeds, it
reranks lexically, and everything else is dates and counts. The reasoning
happens on the other side of MCP, in Claude or Copilot. That is not an
accident: it is why the product runs with no API keys at all, why its ranking
can explain itself, and why an installation costs nothing per answer.

The curation queue (design doc, Surface 4) puts pressure on exactly that line.
An owner clears a weekly batch of short questions, and a question has to be
*written* before it can be answered. For a fact derived from a table the
sentence is a template — `¿{key}.{column} sigue siendo {value}?` — and no model
is involved. For three paragraphs of a meeting note, turning them into one
citable claim is language work.

Two ways to get that done without changing what Diluxite is:

1. **The agent lives outside.** The engine exposes the candidates over MCP and
   a skill running in the client drafts the proposals. Zero cost, zero keys,
   and it is what Diluxite already is.
2. **A provider inside the engine**, configured per organisation, off by
   default.

(1) is not enough on its own, and the reason is operational rather than
technical: **the batch has to be ready on Friday whether or not anybody opened
Claude that week.** A curation ritual that depends on somebody having a session
open is a ritual that stops in the first busy quarter — which is the failure
mode the fixed human budget exists to prevent.

## Decision

**An optional generation provider, per organisation, whose only job is to draft
a question a human will answer.**

### 1. What it may do, and what it may never do

| | |
|---|---|
| **May** | Turn a passage into a one-line claim that can be confirmed with yes/no, with its citation |
| **Never** | Decide whether something is true |
| **Never** | Influence ranking, rank, validity or freshness |
| **Never** | Write to a note, or change any value |
| **Never** | Answer a user's question |

The last one is the product line, not a technicality. Answering stays with the
client AI over MCP. A generation provider that answers is a different product,
with a per-answer cost and a hard model dependency, and it duplicates the
assistant the user already has.

So the containment is: **the model proposes wording, the human decides truth,
arithmetic decides order.** ADR-002's rule — no model in the staleness or
ranking path — survives intact, because drafting is not in either path.

### 2. Off is a working state, not a broken one

With no provider configured the queue still runs: fact candidates carry
templated questions and prose candidates are simply not proposed. The feature
degrades to less coverage, never to an error. Any implementation where the
absence of a key produces a failure is wrong.

### 3. The shape is the one ADR-003 already established

Endpoint plus sealed key on the organisation's row, an admin screen with a
`test` button that tries it once before it is trusted, and the change taking
effect on the running process — the lesson #118 paid for, applied from the
start rather than discovered again.

### 4. The human budget caps the spend, by construction

The queue never drafts more than the owner can review: the weekly call count
**is** the human budget. No separate rate limit to tune, no bill that grows
with the corpus. At ~45 short calls a week the cost is noise beside the
embeddings, which run on every save.

### 5. Every draft is attributed

The proposal records which model wrote it through the provenance that already
exists (`agentKind: 'system'`, `generatedBy`). A promoted page can then say
*"drafted by model X, signed by Pablo on 12-Sep"*, which is what somebody will
ask for the first time a definition is disputed.

## Consequences

- Diluxite gains a generative dependency it did not have. Bounded to one code
  path, off by default, and with a defined behaviour when absent — but the
  claim "this runs with no keys" now needs the qualifier "and curation of prose
  proposals needs one".
- One more provider to configure, test and rotate, in a screen that already
  carries embeddings. Deliberately the same screen: two engines with different
  jobs, not two features.
- A drafting model can write a leading question — one whose yes/no is not
  really the claim in the passage. The mitigation is that the citation travels
  with the question and the owner sees the source line, so a bad draft is
  visible rather than silently promoted. Rejections are recorded with a reason.
- The temptation to let it answer will arrive the week after it ships. This ADR
  exists mostly to make that a decision somebody has to argue for, in writing.

**Explicitly not doing.** A chat surface in the web app. Generation in the
answer path. Generation in the ranking, staleness or validity path. A required
key. A default provider that quietly costs money.
