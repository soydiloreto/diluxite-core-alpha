---
name: session-capture
description: Write what this session learned into Diluxite before it ends — the decision, what changed, and anything that turned out to be wrong. Use when a work session is wrapping up, when the user says they are done or switching topics, or when asked to save/close out the session.
---

# Close the session into the memory

A session ends and everything it learned is in a transcript nobody reads
again. This writes the part worth keeping into Diluxite, through its MCP
tools, so the next session — yours or somebody else's — starts from it.

**Diluxite needs nothing new for this.** It rides the public MCP surface. That
is the point: capture belongs with the agent, not in the engine.

## When to run it

- The user says they are finished, switching topics, or asks to "close out".
- A long piece of work just landed (a PR merged, a bug understood, a decision
  taken).
- **Not** after every message. A memory of everything is a memory of nothing.

## What to write, and what to leave out

Write the things that will be **expensive to rediscover**:

- **Decisions, with the reason.** "We use X because Y" — the *because* is the
  half that stops it being relitigated in a month.
- **What turned out to be wrong.** The approach that failed, the assumption
  that did not hold. This is the highest-value thing here and it has its own
  tool.
- **Where things are** when it was not obvious.

Leave out what the repository already answers: the file list, the diff, the
commit messages. Git holds those, and a note that duplicates them goes stale
the moment somebody edits the code.

## How

**1. Anything that turned out to be wrong goes through `record_correction`,
not `write_note`.** Notes recorded that way rank above ordinary prose for the
questions they answer, because they cost somebody a mistake. Record it the
moment you learn better, not at the end.

```
record_correction
  wrong:   "reindexing empties the live vector space"
  right:   "writes go to both spaces; the reindex fills the new one alongside"
  context: "ADR-003, found while wiring the blue/green flip"
```

**2. Search before you write.** `search_memory` for the topic first: if a note
already covers it, update that one with `write_note` (same title) instead of
minting a near-duplicate. Two notes that half-say the same thing are worse
than either alone.

**3. One note per subject, titled as the thing itself** — not "Session
2026-09-02". A title that names a date is a title nobody searches for. Write
`Blue/green flip of the embedding model`, and the search finds it when
somebody asks about embeddings a month from now.

**4. Declare what is live rather than pasting it.** If the note wants a number
that changes — a metric, a ticket status — do not paste it; declare where to
ask:

    ```resolver
    name: mrr
    url: https://metrics.example/api/mrr
    path: data.value
    ttl: 300
    ```

A pasted number was right when it was pasted, and nothing on the page says it
stopped being right. A declared one comes back with the date it was true.
(The host has to be on the operator's allowlist, or nothing is called.)

**5. Say when something stopped being true.** If this session invalidated an
earlier note, `mark_superseded` it. The note stays readable — what was
believed then remains answerable — and it stops ranking as current.

## The shape of a good note

```markdown
# Blue/green flip of the embedding model

**Decision.** Reads follow the ACTIVE model, writes go to every vector space
that exists. Changing the model no longer empties the live one.

**Why.** Measured before touching anything: saving a new model dropped
semantic search to zero results, and the reindex emptied the space it was
supposed to replace.

**Where.** `packages/core/src/search.ts` — `lanes()` decides read vs write.
```

Short, sourced, and about one thing. If a note needs two headings that share
nothing, it is two notes.

## Before you finish

Tell the user, in one line, what you wrote and where — with the note titles.
A capture nobody knows happened is a capture that gets written twice.
