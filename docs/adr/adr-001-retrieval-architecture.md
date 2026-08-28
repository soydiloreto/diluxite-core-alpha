# ADR-001 — One door, three lanes, and every fact carries its as-of

- **Status:** accepted
- **Date:** 2026-08-27
- **Supersedes:** the "Queryable tables (`query_facts`)" row in `docs/ROADMAP.md`,
  which described a *new MCP tool* and said nothing about freshness.

## Context

Diluxite is the memory an AI reads. The scenario it has to serve, stated
plainly, is: **you are in a meeting, you ask anything, and it answers with the
best it has right now.**

Two things stand between the product and that scenario, and neither is "we
need more data".

### 1. Eighteen doors, and the caller picks

The MCP surface today is 18 tools: `search_memory` (hybrid BM25 + vector, fused
with RRF), `search_by_tag`, `backlinks_of`, `list_notes`, and the rest. Each
capability is its own tool, which is what MCP nudges you toward.

The cost is that **routing is done by the calling model, not by us**. Claude
sees a one-line description and has to guess, without knowing the data, whether
"who consumes the auth service?" is a table question or a prose question. Every
tool added makes that choice harder — the tool-soup problem — and the failure is
silent: it calls `search_memory`, gets prose, and answers plausibly and wrong.
Nobody learns that an exact row existed.

### 2. Nothing knows how old it is

A note says the MRR is 42k. That was true when someone wrote it. Retrieval will
happily return it in a meeting eighteen months later, in the same voice, with
the same confidence, and the person reading it out loud has no way to tell.

This is the actual failure mode of second brains. Not missing information —
**stale information delivered with the confidence of fresh information.**

### What the field already settled, and what it did not

Checked 2026-08-27; sources at the end.

**One entry point is the enterprise consensus.** Glean, Onyx, Elastic, Vectara
and Azure AI Search all expose a single query and fan out internally. The MCP
corner of the ecosystem went the other way, and Diluxite is on that side today.
Moving to one door is a correction *toward* the standard, not a bet.

**Hybrid retrieval + RRF is table stakes.** Already implemented here
(`packages/core/src/rrf.ts`). Not a differentiator; the absence of a real
reranker (`IdentityReranker` is a no-op) is a bigger gap than the fusion.

**Row-level indexing of tables is proven — in a different product category.**
Document-processing RAG does this routinely: Docling and Azure Document
Intelligence emit tables as markdown-pipe rows, and row-level chunking is a
documented technique with published tooling. What has *not* happened is any
note-taking product applying it to the note body. Dataview reads frontmatter and
`key:: value` inline fields; Obsidian Bases is explicitly backed by frontmatter
properties and file metadata, with no extra syntax inside the body. Tana, Notion
and Anytype all get exactness by making you author *into* their structure.

  So deriving rows from a plain GFM table is unusual for this category but not
  unproven as a technique. An earlier draft of this analysis argued the opposite
  — "nobody does it, so it must be hard" — and that was wrong.

**Temporal validity is close to empty, and it is the real opening.** Most RAG
and PKM products cite the source *document* but never say from when a *fact* was
true. Recency in a ranker, and a modification date on a file, are not that. The
exception is Zep/Graphiti, where a bi-temporal model — when the fact was true in
the world, and when the system learned it — is the headline feature: edges carry
validity intervals, a contradiction closes the old window (`superseded_by`)
rather than deleting the row, and the graph answers as-of-time queries. The
underlying idea is old and safe: bi-temporal modelling has been standard in data
warehousing for decades. It is simply rare *here*.

## Decision

### 1. Knowledge is filed by how fast it decays

Not by format, not by source. This is the discriminator everything else hangs
off.

| Tier | What it holds | Where it lives | Freshness |
|---|---|---|---|
| **Events** | prose, decisions, meeting notes, ADRs, PRDs | Markdown notes, as today | eternal — "we decided X on date Y" never goes stale |
| **Derived facts** | rows of tables written inside notes | derived index (`query_facts`) | inherits the note's save |
| **Live state** | metrics, ticket status, dashboards | **not copied** — the note declares *where to ask* | resolved at query time |

**Store what happened. Point at what is.** Copying a metric into a note is how
you build a machine that lies with confidence.

Tier 2 is **derived, never authored** — the same contract tags and wikilinks
already have (`SearchService.index`). Nobody edits a fact; you edit the note and
the index rebuilds. That guarantees exactly one place to correct a wrong value,
and it is what "Markdown stays the source of truth" has to mean to be worth
anything.

### 2. One entry point, three lanes, composed rather than fused

`search_memory` stays THE way in. Internally it runs the lanes it has and
composes an answer:

```
query ─┬─→ structured  (indexed SQL over query_facts / resolvers)
       ├─→ lexical     (Postgres FTS)          ─┐
       └─→ semantic    (pgvector)              ─┴─→ RRF, unchanged
                    │
                    └─→ exact hit?  YES → the row FIRST, labelled as a fact,
                                          with source and as-of; prose below
                                          as context
                                     NO → today's fused ranking, untouched
```

**The structured lane runs on every query.** It is one indexed lookup next to an
embedding call we already pay for — orders of magnitude cheaper. Running it
unconditionally removes the need for a classifier, a heuristic, or a routing
decision by anybody.

**Facts do not go through RRF.** RRF fuses *rankings* and deliberately discards
scores, which is exactly what makes it good at combining BM25 with cosine
distance — and exactly what makes it wrong here. A table row is not "somewhat
relevant": it either matched or it did not. Averaged into prose it lands third
behind two paragraphs about the topic, which is precisely the answer the user
came for, lost. Confidence is the signal RRF throws away, so the composition is
**hierarchical, not fused**.

**Response format is part of the contract.** `search_memory` returns
`"1. Title\n   snippet"` today. A fact returned in that shape reads as more
prose and gets treated as opinion. Facts come back marked, with their note of
origin and their as-of.

A second tool is justified for exactly one thing, and it is a matter of response
*shape*, not of search: dumping a whole table as rows. One tool to ask, one to
dump. Not one per index.

### 3. Nothing leaves without its as-of

**No value is ever returned without the date it was true.**

This single rule is what makes the meeting scenario safe. "MRR 42k (12 minutes
ago)" is something you say out loud. "MRR 42k (March)" is something you go check.
Same number, opposite behaviour, and the difference is a timestamp.

It follows that the system must be able to say **"I don't know"** and **"this is
old"**. A second brain that always answers is one you cannot trust on any single
answer. Serving a cached value when the source is unreachable is fine — serving
it bare is not.

Following Graphiti's shape, a superseded fact is **closed, not deleted**: it
keeps the window in which it was true, so "what did we believe in March?" stays
answerable. This also matches what ingestion already does — the DDW connector
annotates a vanished source as archived rather than trashing it.

## Consequences

**Order of work — and it is not the order the roadmap has.**

1. **Provenance + as-of on everything already indexed.** Every result knows
   which note and which line it came from, and from when. Cheapest of the three,
   and the enabler: without it, steps 2 and 3 build a more precise liar. It
   improves what ships today, on its own, with no other step.
2. **`query_facts` as a lane inside the single door** — derived from GFM tables
   at save time, exact hits composed above the prose.
3. **Resolvers for live state** — the bridge. Last, because it needs step 1's
   scaffolding to be safe, and because it is the only one that reaches outside
   the product.

Ranked by value-to-risk that is roughly the inverse of the current roadmap,
where `query_facts` is the only thing written down and freshness does not appear
at all.

**What this costs.**

- The 18-tool surface is public API. Tools are not deleted here; `search_memory`
  absorbs the structured lane and the rest stay. Removing any of them is a major.
- GFM tables are genuinely ambiguous — which column is the key, whether headers
  are stable across notes, layout tables that are not data. The competitors who
  demand a convention bought disambiguation with friction. Deriving from plain
  tables buys zero friction and pays in ambiguity. That trade is accepted
  deliberately, and the `query_facts` spec owes an answer for key selection and
  for tables that should not be indexed at all.
- As-of has to be threaded through the index, the API and the MCP response
  format. Retrofitting it later is far more expensive than doing it first, which
  is the whole reason it is step 1.

**What we are not doing.** Live federation for everything (latency and
reliability make it a bad default — the industry indexes and accepts a crawl
cadence, and so do we, but with the age on screen). A fact-editing UI (facts are
derived; you edit the note). A tool per index.

## Sources

Checked 2026-08-27.

- [Graphiti: Knowledge graph memory for an agentic world (Neo4j)](https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [What Is a Temporal Knowledge Graph? (Zep)](https://www.getzep.com/ai-agents/temporal-knowledge-graph/)
- [getzep/graphiti](https://github.com/getzep/graphiti)
- [Temporal Validity in Retrieval Memory: Eliminating Stale-Fact Errors for AI Agents over Evolving Knowledge](https://arxiv.org/pdf/2606.26511)
- [Dataview — Adding Metadata](https://blacksmithgu.github.io/obsidian-dataview/annotation/add-metadata/)
- [blacksmithgu/obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview)
- [An Overview of the Bases Core Plugin in Obsidian](https://practicalpkm.com/bases-plugin-overview/)
- [Obsidian Bases Plugin vs Dataview: Which to Use in 2026](https://locul.ai/blog/obsidian-bases-plugin)
- [Retrieve One Row from a Table, Not the Whole Table: Row-Level Chunks for RAG](https://towardsdatascience.com/retrieve-one-row-from-a-table-not-the-whole-table-row-level-chunks-for-rag/)
- [Prep your Data for RAG with Azure AI Search: Content Layout, Markdown Parsing (Microsoft)](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/prep-your-data-for-rag-with-azure-ai-search-content-layout-markdown-parsing--imp/4303538)
- [Beyond Plain Text: Egnyte's Journey to Structured Data Extraction in RAG Systems](https://www.egnyte.com/blog/post/beyond-plain-text-egnytes-journey-to-structured-data-extraction-in-rag-systems)
