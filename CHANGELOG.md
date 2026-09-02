# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Changing the embedding model took semantic search down, and the reindex
  destroyed what it was supposed to replace.** Measured on the shipped code:
  the moment a new model was saved, semantic search returned **zero results** —
  the query was embedded with the new provider and asked its empty partition —
  while the catalogue still called the old model active, so `related` (the
  Neighbors panel) answered nothing at all. The reindex then filled the new
  space and, because replacing a note's chunks cascades to its vectors,
  **emptied the old one**: an `active` model with no vectors and nothing to
  roll back to. Two code paths disagreed about which model is live — search
  followed the configuration, `related` followed the catalogue.
  The catalogue decides now: **reads always come from the active model, writes
  go to every space that exists** (ADR-003's dual write), so a reindex fills
  the new space alongside the live one instead of replacing it. That needs the
  active model's provider to be rebuildable while the configuration already
  describes the new one, so migration 0034 puts each vector space's endpoint
  and sealed key on its own catalogue row.

### Added

- **Search quotes the passage that matched, and the whole note is one tool call
  away.** Results used to quote the note's *opening*: a search that found its
  answer in the last paragraph showed the first one, and the reader had to open
  the note to find out why it came back at all. Now the matching passage is the
  snippet — in the app and over MCP. Each hit also carries a `ref`, and the new
  MCP tool **`expand_memory`** returns everything known about it: the full
  text, how it stands (confirmed, expired, no longer true), any live values it
  declares, and the exact rows its tables state. A hit that arrives as a full
  note spends context on the four results that were not the answer; this way
  the model pulls the whole thing only when it decides it needs to. Standing
  comes first in that answer, deliberately — a reader who learns it afterwards
  has already believed the rest. Twenty MCP tools now.

- **A stored number that stopped matching its source now says so.** ADR-002
  promised a downward move — a value loses authority when a check against
  reality disagrees — and until now there was nothing to check against. There
  is: a table cell and a resolver in the same note, under the same name, are
  two claims about one thing, and the source is the most impartial judge
  available and works for free. When they disagree the answer says it out
  loud: *"mrr: 99 (2 minutes ago) · ⚠ the note still says 42 on line 5"*, in
  `search_memory` and in the note's own panel. It is the half most systems
  omit — they let a number go quietly wrong. Compared **loosely** on purpose:
  `3%`, `3 %` and `3.0%` are one claim written by three people, and crying
  wolf over that trains everybody to ignore the warning, which costs exactly
  the cases where it mattered.

- **Live state, resolved at query time — ADR-001 step 3 is done** (migration
  0041). Metrics, ticket status and dashboards are **not copied into the
  memory**: a note declares where to ask in a fenced ```resolver block (name,
  url, an optional dotted path, a ttl) and the engine resolves when somebody
  asks, bounded by the notes a search actually returned. Copying is what makes
  a second brain wrong in the way that matters — the number was right when it
  was pasted, and nothing on the page says it stopped being right.
  **The rule the whole lane exists for: no value is ever returned without the
  date it was true.** A source that is down serves its last known value *with
  its age*, never bare; a source nobody has ever reached says **unknown**
  rather than a number, because a second brain that always answers is one you
  cannot trust on any single answer. It rides above the prose in
  `search_memory`, composed and never fused into the ranking — a value either
  resolved or it did not, and averaging that into relevance throws away the one
  signal that separates it from an opinion.
  **The trust boundary is an operator allowlist**, and without it this feature
  would be a server-side request forgery with a nice syntax: a note is user
  input that would otherwise choose which addresses the server reaches. So the
  note says *where*, the operator says *which hosts and how to authenticate* —
  a credential never lives in a note. Hosts match exactly (a suffix match is
  how this check is got wrong), redirects are refused (one hop undoes the
  allowlist), and there is a timeout and a size cap. A slow dashboard is served
  from cache rather than becoming a slow search.

- **The weekly batch builds itself.** The Review screen had a button and
  nothing else, which makes the ritual depend on somebody remembering to press
  it — and a ritual that depends on that is one that stops in the first busy
  quarter, which is exactly what a fixed human budget is designed to survive.
  A sweep now rebuilds any space whose batch is older than the interval (weekly
  by default; `DILUXITE_CURATION_INTERVAL_DAYS=0` leaves only the button). It
  **proposes and nothing else** — it never confirms, never supersedes, and
  every card still waits for a person. A batch younger than the interval is
  left alone, so clearing the last card does not conjure a fresh one, and a
  space the memory has never leaned on is never proposed at all. Two API
  replicas cannot both build the same week: the sweep takes a Postgres advisory
  lock and skips rather than queues. The build itself moved out of the route so
  the button and the scheduler run the same code — two copies would drift, and
  the one that drifts is always the one nobody watches.

- **The left bar can say what its icons mean.** It was a strip of icons, which
  is fine once you know them and opaque until then. The brand mark at the top
  is now the control that widens it into labels — it was the one button there
  that did nothing a second click elsewhere could not do. Three states, cycled
  from it and remembered: **auto** (labels at the top level, icons once a panel
  opens beside them), always-labels, always-icons. The accessible name of every
  button stays the same in both layouts, so nothing has to know which one is on.
  **Home is its own button** now, first in the list, and it lands on the Welcome
  tab. And clicking Explorer a second time no longer closes the panel: it used
  to hide the notes, which reads as losing them rather than as tidying up.

- **The graph's controls moved into their own column.** View mode, how many
  nodes to draw, the zoom read-out and *Fit view* were a strip along the top of
  the canvas, where a dropdown and a slider competed with the breadcrumb for one
  line and the graph lost height to chrome on every screen. They are a panel on
  the right now, with the selected-node inspector below them — and the view
  modes are a list with their hints visible instead of a `select` nobody opens.

- **The drafting provider is real, and it is still the only thing a model may
  do** ([ADR-006](docs/adr/adr-006-generation-provider.md), migration 0040).
  Optional, per organisation, off by default, configured beside the embedding
  provider in Admin → AI with the same shape: endpoint, sealed credential, and
  a **try it once** button before it is trusted. Its only job is to turn a
  passage into a one-line claim an owner can answer with yes or no. It never
  decides whether something is true, never touches ranking, validity or
  staleness, never writes to a note, and **never answers a user's question** —
  answering stays with the client AI over MCP. The port itself returns a
  *claim*, not an answer, so the containment is structural rather than a
  promise. **Off remains a working state**: exact values keep their templated
  questions and prose is quoted instead of summarised. A passage that states
  nothing confirmable produces **no card** rather than an invented one, a
  drafting failure costs a better sentence and never the card, and the weekly
  call count is capped by the human review budget, so the spend caps itself.

- **The weekly batch exists: a Review screen, one card at a time.** The ritual
  from *Company Brain — modo funcional* §8, which ADR-002 modelled and never
  built. A card is one question, its citation, why it is being asked (*"used 9
  times · nobody has signed it"*) and three buttons — **yes, it holds** signs
  the note (`rank: preferred` plus who and when), **no, it changed** supersedes
  it, **not mine** hands it on. A rejection carries its reason, refused by the
  route *and* by the table: an owner must not be able to drop something from
  the record in silence, and "visible and appealable" is only true if the
  reason exists. One card at a time on purpose — a list invites reading ahead
  and deciding in bulk, which is how a review becomes a rubber stamp.
  **The budget is enforced, not aspirational.** It is expressed in decisions,
  not minutes, because nothing can measure a person's minutes: the divisor is
  the **measured** median time per decision (migration 0039), so if decisions
  get slower fewer are proposed with nobody adjusting anything, and a fresh
  installation proposes a small cold-start batch instead of guessing. Building
  **replaces** the open batch rather than appending to it — there is no
  backlog by construction, and what did not fit competes again next time.
  Candidates rank by *how often it was used × how long since anyone confirmed
  it × what breaks if it is wrong*, multiplied rather than added: something
  read constantly but signed yesterday is not worth a question, and neither is
  something nobody has ever read. Archived, trashed and already-superseded
  notes never reach the batch.

- **What the memory leans on is counted now.** Nothing recorded how often a
  note was actually used to answer, and without that number the curation queue
  cannot exist: it ranks candidates by expected value, and the first term of
  that is usage. Asking an owner to confirm the note nobody reads while the one
  behind every answer goes unchecked is worse than not asking. Migration 0038
  adds `entity_usage` — **counters only, never a log of individual uses**: a
  log grows with traffic and records who read what, which is surveillance
  nobody asked for. One statement per search, for the page of results actually
  returned, so the cost is bounded by topK and not by the corpus; a counter
  that cannot be written never fails somebody's search.

- **[ADR-006](docs/adr/adr-006-generation-provider.md) — a generation provider,
  for drafting only.** Diluxite has had no generative model anywhere, and that
  is why it runs with no API keys, why its ranking can explain itself, and why
  an answer costs nothing. The curation queue presses on that line: a question
  has to be *written* before an owner can answer it, and while a fact derived
  from a table gets a templated one (`printf`, no model), turning three
  paragraphs of a meeting note into one citable claim is language work. So: an
  **optional provider, per organisation, off by default**, whose only job is to
  draft a question a human answers. It never decides truth, never touches
  ranking, validity or staleness, never writes to a note and **never answers a
  user's question** — answering stays with the client AI over MCP. Off is a
  working state, not a broken one: without it, facts still get their templated
  questions and prose candidates are simply not proposed. The weekly call count
  *is* the human review budget, so the spend caps itself by construction. It
  goes in from the start, for one operational reason: the batch has to be ready
  on Friday whether or not anybody opened Claude that week.

- **ADR-002 gains an addendum** naming the ritual it left out. Its rejection of
  the single reliability ladder stands — one number cannot hold three
  independent facts — but the ladder's *ritual* was never rejected and nothing
  replaced it: its levels are a **reading** of rank plus provenance (N3 is
  `rank: preferred` plus who signed), so what is missing is only what produces
  those values.

- **Archive a note: out of the tree, still in the memory.** A note had two
  states a person could reach — live, and in the trash — so "I am done with
  this, stop putting it in front of me, but do not lose it" had to go to the
  one place that is on its way to destroying it. Archiving is a flag on the
  note (migration 0035), not a move, a folder or a third state: the note
  leaves the explorer tree and the recents, and it **keeps answering searches
  and MCP calls**, marked as archived and ranked below live results. The
  demotion is applied after the top-K cut on purpose — a penalty before it
  would push archived notes out of the answer entirely, which is the soft
  delete this feature exists to avoid. `PUT /api/notes/:id/archive`, an
  Archive view in the activity bar, and a toggle in the note's title bar.
  Archiving does not touch `updated_at`: it is not an edit, and bumping it
  would drag the note back to the top of the recents and make it look freshly
  confirmed to the staleness assessment.

- **The note says what it knows about itself.** An ⓘ in the title bar opens a
  panel with ADR-002's three axes as a sentence rather than a form: who wrote
  it and through which door, since when it is valid and until when, whether
  anybody has signed it, and how fast it actually changes — *"changes every
  ~40d · last changed 120d ago"*. It is also the only place a person writes
  `valid_to`: **it still holds** (signs it), **no longer true** (closes the
  window, reversible), and **set an expiry date**. Six locales.

- **Standing weighs on the order now.** ADR-002's third axis was inert: a note
  past its own measured cadence got a badge and kept its position, and a
  superseded one ranked exactly like a live one. A warning that changes nothing
  is a warning nobody acts on. Rank, expiry and age are now **multipliers** on
  the score — not a re-sort by category, so a strong match slightly overdue
  still beats a weak match that is fresh — applied last, over the results
  already chosen, the same placement archiving uses and for the same reason:
  an out-of-date note is answered lower, never removed. Migration 0037 stores
  them per organisation, which is the one part of this line where the criterion
  genuinely differs between a company and one person's second brain; the ageing
  estimate itself stays per note and deliberately not configurable. **The
  defaults are not neutral on purpose** — mild for age (being overdue is a
  suspicion), firm for expired (somebody said it stops being true), a small
  boost for signed. Expired results are marked, not hidden, unless an admin
  turns `hideExpired` on. All of it arithmetic over dates and counts: no model
  is consulted, and ADR-002 forbids putting one in this path.

- **Validity has doors now.** `supersede()` shipped with ADR-002 — it closes a
  note's validity window and drops its rank to `deprecated` without deleting
  the row — with an integration test and **no caller anywhere**, so `valid_to`
  was never written by anything and the whole validity axis was schema nobody
  could reach. Five routes and two MCP tools open it: mark something as no
  longer true (reversible — a judgement that cannot be undone is one people
  stop making), declare the date it stops being true, sign it, and read the
  whole picture back for one note. The distinction the API encodes, because it
  is the one everybody collapses: **superseding closes the window now**, while
  **an expiry is a future date with the rank untouched** — the note is current
  until then and becomes expired by the passing of time, compared where it is
  read, with nothing scheduled and no pass over the corpus. Migration 0036 adds
  `confirmed_by`/`confirmed_at`, deliberately **not** reusing `attributed_to`:
  that column is the author of the content, and signing a page must not rewrite
  its authorship into the name of the last reviewer.

- **Written down: where expiry, validity and rank are actually decided**
  ([`docs/validity-surfaces-design.md`](docs/validity-surfaces-design.md)).
  ADR-002 landed the model — three orthogonal axes and decay measured from
  observed change — and none of the doors: `supersede()` closes a validity
  window, deprecates without deleting, has its integration test, and **no
  caller anywhere**, so `valid_to` is never written by anything. The document
  separates what is measured (a note's own rhythm, nobody configures it) from
  what a person must declare (a date the world imposes, "this no longer
  holds") from what an organisation sets once (how much each weighs in the
  ranking), and names the four surfaces that follow. It also folds back in the
  curation ritual from *Company Brain — modo funcional*: a promotion queue an
  agent fills and an owner clears in a fifteen-minute weekly batch, with the
  human budget fixed — when candidates exceed it the bar rises, never the
  load. No code yet: this is the proposal to review before any of it is built.

- **The blue/green flip is reachable.** `activate()` existed in the repository
  and was tested, and no route or screen called it — a model change left an
  organisation with a `building` space that could never become live.
  `POST /api/organizations/:orgId/embeddings/activate` makes it live, and
  Admin → AI grows a panel that appears only while a change is in flight:
  how many chunks the new space holds against the total, and the button. It
  **refuses an unfilled space** unless forced, because flipping to one is a
  search that quietly stops finding things. The reindex also takes
  `activateWhenDone`, which is the same two steps in one click for the corpus
  sizes where the difference does not matter — checked by default in the UI.
  Deliberately not a synchronous rebuild inside the request: re-embedding a
  corpus takes minutes to hours, every proxy in the path has a timeout, and
  the point of building alongside is being able to look before committing.

### Security

- **Styles are allowed by name now, not by opening the policy.** `style-src`
  carried `'unsafe-inline'` — which also allows every inline style an XSS
  writes — because the app injects a handful of `<style>` tags at runtime.
  It now carries a per-request nonce instead: nginx stamps `$request_id` into
  both the `Content-Security-Policy` header and `index.html`, and the one
  library that injects styles (CodeMirror, through style-mod) is handed it via
  `EditorView.cspNonce`. The document was already `no-store`, which is what
  makes a per-request value safe to put in it. Nothing else in the bundle
  injects styles: Vite emits CSS as a stylesheet link, React sets style props
  through the CSSOM (which CSP does not gate), and dockview only injects into
  popout windows, which this app does not use. `pnpm dev` has no nginx, so the
  placeholder stays as it is and the editor runs without a nonce, as before.

### Changed

- **The dev stack's published ports are settings now, not constants.** Anyone
  running a second project on the same machine hits the collision immediately:
  two stacks both want 5432, and the loser silently does not start. Every port
  `docker compose` publishes reads from a variable with today's value as the
  default (`DILUXITE_DB_PORT`, `DILUXITE_API_PORT`, `DILUXITE_COLLAB_PORT`,
  `DILUXITE_WEB_PORT`, `DILUXITE_ADMINER_PORT`), so it moves from `.env`
  instead of by editing a tracked file. Inside the compose nothing changes —
  the services talk over the internal network — so moving a host port only
  changes where *you* connect. Production is unaffected: the installer
  publishes the web port only, and already auto-detects a busy one.

### Fixed

- **Moving that port pointed the integration tests at another project's
  database.** `TEST_DATABASE_URL` defaulted to a hardcoded `localhost:5432`
  and Vitest reads no `.env`, so the suites would connect to whatever answered
  there — and their setup begins with `TRUNCATE`. The base URL now falls back
  to `TEST_DATABASE_URL` from `.env` before that constant. It is read in
  `test/integration-db.ts`, where the constant is computed, and not in
  `vitest.config.mts`: the config imports that module, and a module body runs
  before the importer's statements, so an assignment there was already too
  late.

### Added

- **Import a vault: Obsidian, Notion, or any folder of Markdown.** Admin →
  Current workspace → *Import a vault (.zip)*, or
  `POST /api/spaces/:spaceId/import`. Folders become folders, wikilinks and
  inline `#tags` come across as they are — the format the export already
  writes, read back. **A dry run always runs first**, so the confirmation
  states the real numbers instead of asking "are you sure?": how many notes,
  how many files skipped, and which format was detected.
  Three shapes are handled, and the difference is deliberate: Obsidian is
  already what this product speaks; Notion needs its 32-hex ids stripped from
  every title and folder and its relative page links turned into wikilinks, or
  every note would be titled with a hash; and everything else — Joplin's
  Markdown export included — is imported as plain Markdown with links left
  exactly as they are, because guessing at a format's link syntax produces an
  import that looks complete and is quietly broken.
  Nothing is overwritten: a note whose title already exists is reported and
  left alone, which also makes re-running the same import create nothing.
  Attachments are not imported (there is nowhere to put them yet) and are
  listed as skipped rather than dropped silently.

### Added

- **Tag a selection of notes at once.** Right-click a multi-selection in the
  explorer → *Tag N notes…*, or `POST /api/notes/tag-many` with `add` and
  `remove`. It works by **editing each note's markdown**, not by writing
  `note_tags` rows: tags are derived, and every save recomputes them from the
  body — rows written behind the text would look like the operation worked and
  disappear the next time somebody typed a character. There is a test that
  edits a note afterwards and checks the tag survived. Each note goes through
  the same write path an ordinary edit takes, `applyServerEdit` included, or a
  live collaborative document would flush the old text back over it. Notes that
  already carry the tag are left byte-identical rather than re-saved (no
  version, no re-index), and the response says so: `{ updated, unchanged,
  refused }`. Authorised one note at a time, like `delete-many` — a selection
  can span workspaces, and refusing the whole batch over one unreachable note
  is worse than doing the rest and saying what was skipped.

### Security

- **The page that runs the app was served with no policy at all.** Helmet's
  Content-Security-Policy sits on `/api/*` — JSON nobody executes — while
  `index.html` came from nginx with no security headers whatsoever, and a
  browser enforces a page's CSP from the response that delivered the DOCUMENT.
  So the policy everyone believed was protecting the app was protecting the
  part that did not need it: anything that got a `<script>` into the page ran
  unopposed. Both images now serve the document, the SPA fallback and the
  hashed assets with a CSP (`script-src 'self'`, no inline, no eval),
  `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and
  `Cross-Origin-Opener-Policy`, from one shared snippet the two nginx configs
  include. The proxied `/api` and `/mcp` locations deliberately do not add
  one: two Content-Security-Policy headers are not additive, and the browser
  would enforce the intersection. Styles keep `'unsafe-inline'` — the Vite
  critical-CSS path and CodeMirror both inject style tags, and tightening that
  needs a per-request nonce, which is its own change.

### Fixed

- **The lexical channel indexed every note as if it were Spanish.**
  `keywordSearch` and the GIN index behind it used
  `to_tsvector('spanish', text)` for all content, whatever language it was
  written in — so "backups" never reached "The backup stores the database" and
  "modifica" never reached "Le modifiche viaggiano su WebSocket". The
  evaluation had just put a number on it: three inflection probes out of three
  lost, per language. An expression index can only ever hold one
  configuration, so this was not something the index could fix; migration 0033
  moves the lexemes into a stored `tsv` column computed from a per-row
  `fts_config`, and one GIN index now serves four languages. The language is
  detected once per note at index time from its function words
  (`packages/core/src/language.ts` — no new dependency: `franc` and friends
  carry trigram models for 180 languages to decide between four, and this
  image's supply chain is worth more than that). Code fences and links are
  masked out before detection, because every identifier in a fence is English
  and `.com` is a Portuguese word. A note whose language cannot be told keeps
  Spanish, which is what it had. **Existing notes keep their current indexing
  until they are next saved or reindexed** — the migration changes no result
  on its own.

### Added

- **`/metrics`, in Prometheus exposition format.** Off by default: it exists
  only when `DILUXITE_METRICS_TOKEN` is set, and answers 404 rather than 401
  without it — an endpoint that lists every route, its traffic and the running
  version is a map of the installation, and an unauthenticated caller should
  not learn whether this one has one. It carries request counts and a latency
  histogram by method and route, the embedding provider's calls, failures,
  texts and duration, process uptime and memory, and a `build_info` gauge. The
  provider metrics come from a decorator around whatever embedder was built,
  rather than counters inside each of the four — three copies of the same code
  waiting to drift. Routes are labelled by their PATTERN and anything
  unmatched is `route="unmatched"`: a label carrying user input is how a
  time-series database gets filled from outside. No new dependency —
  `prom-client` brings a default registry this product does not use into an
  image whose dependency surface is audited on every PR, and a counter, a
  gauge and a histogram are two hundred lines with the format written down.

- **A reproducible search benchmark** (`pnpm bench`). The performance claims in
  ADR-003 — 4.3 ms against 98.6 ms at 20k vectors, the "23×" — were measured
  once, by hand, on one machine. Now there is a harness: a deterministic
  corpus in four languages, a fixed query suite, and a table of p50/p95 for
  the keyword, semantic and hybrid lanes plus indexing throughput. It measures
  what the API calls (`SearchService` over `DrizzleSearchRepository`), not
  hand-written SQL shaped like what the repository is believed to send. The
  vector lane is measured twice — as shipped, and over a connection that
  starts with `enable_indexscan=off` — so the ratio between them is what the
  HNSW index is worth, in the same process, on the same rows. **ADR-003's claim
  reproduces**: at the 20k vectors × 1536 dims it was measured on,
  `vectorSearch` runs in 3.4 ms against 124.6 ms without the index — 36×, where
  the ADR recorded 4.3 ms against 98.6 ms. At 256 dims the same corpus gives
  2.2 ms against 29.9 ms, 13.6×: the narrower the vector, the less a
  sequential scan costs, which is why the ratio is a number that only means
  something next to its parameters. Whole-lane latency at 1536 dims: keyword
  24.3 ms, semantic 16.3 ms, hybrid 27.9 ms (p50); indexing 28.5 notes/s.

### Fixed

- **`scripts/` was not typechecked, and `pnpm seed` was broken on a fresh
  database.** Nothing in `pnpm typecheck` or `pnpm lint` ever looked at the
  scripts, so the only way to find out one no longer compiled was to run it.
  The seed's bootstrap branch — the one that only executes on a database with
  no workspace yet — inserted a space without an organisation, which
  `spaces.org_id NOT NULL` has rejected since ADR-005. `tsconfig.scripts.json`
  joins the typecheck, and it caught this on the first run.

### Added

- **The search evaluation now runs in four languages.** The Spanish baseline
  became one of four corpora — Spanish, English, Brazilian Portuguese and
  Italian — that are translations of each other: the same six notes and the
  same ten questions, so a hit rate that drops in one language is telling us
  about the pipeline and not about an easier fixture. Measured today: hit@1 of
  0.90 (es), 1.00 (en), 0.90 (pt-BR) and 0.80 (it), hit@3 of 1.00 everywhere.
  Each floor sits one query below its measurement, which on a ten-question
  suite is exactly one regression.

### Measured

- **The lexical channel indexes every language as Spanish.** `keywordSearch`
  and the GIN index behind it use `to_tsvector('spanish', …)` for all content,
  whatever it is written in. The evaluation now puts a number on the cost: of
  three inflection probes per language — a query word that is a different
  surface form of a word in the note — **three of three are lost** in English,
  Portuguese and Italian, and all three match under the language's own
  configuration. "backups" does not find "The backup stores the database";
  "modifica" does not find "Le modifiche viaggiano su WebSocket". English also
  indexes its stopwords as content: eight lexemes where the English
  configuration keeps five. The vector channel hides most of this in the fused
  ranking, which is why it went unnoticed. The fix — a text-search
  configuration that follows the note's language — is its own change; this one
  is the evidence for it.

### Fixed

- **Admin → AI promised a step that does not exist.** Saving a provider that
  changes the model said the new one "goes live once you reindex". It does
  not: the reindex re-embeds into the *active* vector space, and nothing
  activates the new one. The copy now says what actually happens — the choice
  is saved, the new vector space is registered and empty, and search goes on
  using the current model until switching is wired (roadmap 48b). The panel's
  own header still described the provider as an install-time env var, which
  stopped being true two releases ago.

- **Choosing an embedding provider did nothing until the container was
  restarted.** The provider an organisation searches with is built once and
  memoised — reading its configuration is a query and every search asks — and
  nothing told that memo when the configuration changed. An admin could point
  the organisation at a different endpoint, see it saved, and the running
  process would go on embedding with the old one. The console promised a
  setting and delivered a note-to-self. Writing the configuration now
  invalidates it.

- **The test helper leaked vector partitions.** It dropped them by `key` after
  a partition became named after the `slot` — `"<org>:<model>"` since
  embeddings went per organisation — so the `DROP` matched nothing, silently,
  while the catalogue rows were deleted out from under real partitions.

### Corrected

- The roadmap said the blue/green flip was wired to Admin → AI in #113. It is
  not: `activate()` exists in the repository and is tested, but no route or UI
  calls it, and the reindex re-embeds into the **active** vector space rather
  than the one being built. A model change today therefore leaves the
  organisation with a `building` space that cannot become active. The 48b row
  now says so, and what is genuinely shipped is listed separately.

### Fixed

- **One database per vitest project.** The `db` and `api` integration suites
  each run their files one at a time, but vitest runs the *projects* in
  parallel — and both pointed at `diluxite_test`. The db suite truncates
  `users`, `notes`, `spaces` and `organizations` between cases, pulling rows
  out from under whatever the api suite was doing.

  Measured, in both directions: with the db suite looping in the background,
  7 of the 9 tests in `trusted-header.integration.test.ts` go red; after the
  split, 3 runs of 3 pass under the same load.

  Both databases derive from `TEST_DATABASE_URL`, so pointing the suite
  somewhere else still works — only the database name gains a `_db` / `_api`
  suffix.

  This also flushed out a test that had been leaning on its neighbours: the
  HNSW index check analysed only `chunk_embeddings`, and on a database that
  was not full of other suites' rows the planner had no statistics for the
  joined tables and chose a sort. It analyses all three now.

- **Listings could come back in a different order each time they were asked
  for.** Every ordering that was not a total order now has a tiebreaker.

  `updated_at` and its siblings default to `now()`, the transaction's start
  time, so everything written in one transaction — an import, a batch MCP
  write, a bulk delete — carries the identical timestamp. Sorting by that
  column alone leaves the order among them to the planner, and it need not be
  the same twice. In the explorer that reads as items shuffling on their own.

  Touched: the note list and the trash (`updated_at` / `deleted_at`), note
  version history, the organisation and workspace listings, and keyword
  search — where `ts_rank` ties constantly and the `LIMIT` was therefore
  keeping an arbitrary subset of the tied chunks, so two identical searches
  could return different results.

  **Vector search is deliberately left alone.** Its `ORDER BY` is what lets
  the planner walk the HNSW index in order; a second sort key would cost the
  index scan, which is 23× on the measured corpus. Exact distance ties there
  mean identical vectors — a different problem.

### Fixed

- **The audit log dropped entries when paged.** `list` sorts by `(at, id)` but
  the cursor filtered on `id` alone.

  The two are not the same order. `at` defaults to `now()`, which in Postgres
  is the transaction's **start** time, while `id` comes off a sequence at
  **insert** time — so a transaction that begins first and inserts last
  carries the earlier `at` with the higher `id`. Once they disagree the page
  boundary cuts somewhere other than the sort, and the rows in between are
  returned by no page at all. Nothing raises: the caller gets an audit log
  quietly missing entries, which is the one thing an audit log may not do.

  The cursor is now a keyset on the same tuple the query sorts by. The caller
  still passes only the last row's id — its `at` is looked up server-side, so
  the public contract is unchanged. Measured at 100k events: index scan on
  `audit_events_at_idx`, 51 rows read, 0.06 ms.

  This was on the roadmap as an occasional test flake. It was not a flake —
  the two vitest projects writing concurrently just made the interleaving
  happen often enough to see.

- **A model that belonged to no organisation could exist, and it bypassed the
  one-live-model rule** — migration 0032.

  0031 added `org_id` to a table that already had rows, so it could not be
  born `NOT NULL`. The guarantee the blue/green flip rests on is the partial
  index `UNIQUE (org_id) WHERE state = 'active'`, and in Postgres two NULLs
  are distinct: an organisation-less row violated nothing, and there could be
  any number of them, all active.

  Nothing read them — every query filters by `org_id` — and none owned
  vectors, since a partition's slot carries the organisation first. Dead data
  that held the hole open. It is deleted and the column is now `NOT NULL`.

  Found on a **freshly migrated** database, not only on a hand-mutated one.
  The new test inserts straight at the table rather than through the
  repository: going through the repository proves the repository is careful,
  not that the rule is enforced.

### Added

- **Three roles, and each organisation chooses its own embedding provider** —
  [ADR-005](docs/adr/adr-005-tenancy-roles-and-per-org-embeddings.md),
  migrations 0030 and 0031.

  `super_admin` / `admin` / `member` become **`setup_admin` / `org_admin` /
  `org_member`**. Not a fourth level — a reframing of the three that existed,
  since the old top two differed only in "may delete the org" and "may demote
  the owner". `setup_admin` owns the **installation** and lives on `users`,
  because it is not about an organisation; owning the installation is
  explicitly NOT owning the data in it, and a test says so.

  And `chunk_embeddings` is now partitioned by **(organisation, model)** with
  configuration to match. Two measurements drove it:

  - **A shared index silently breaks the smaller tenant.** Ten vectors of org
    A in an HNSW index with twenty thousand of org B's: A asks for its five
    nearest and gets **zero** — the index returns its 391 nearest candidates,
    all B's, and the tenant filter removes every one. A does not get back its
    own vector at distance zero. pgvector 0.8's iterative scan pushed that to
    7,931 rows examined and still returned zero. With its own partition: five
    of five. Not a leak — a tenant that searches, finds nothing, and sees no
    error.
  - **It costs nothing.** HNSW is roughly linear (2,000 vectors → 5.9 MB,
    20,000 → 125 MB), so ten organisations of 2,000 each come to ~59 MB
    against ~125 MB pooled. Cheaper *and* correct.

  Isolation gains a physical dimension as a result: one organisation's vectors
  are not filtered out of another's partition, they are not in it.

- **Export a workspace as Markdown files** — `GET /api/spaces/:id/export.zip`,
  and the button in Admin → Current workspace. One `.md` per note, in the
  folder it was written in, body verbatim: wikilinks and inline `#tags`
  untouched. Obsidian, VS Code and `grep` read it with no importer. Metadata
  the body cannot carry (`id`, title, created, updated, favorite) goes to YAML
  frontmatter — and only that, since tags are already inline and a second copy
  is a second copy to disagree with the first.

  A second brain you cannot walk away from is a silo with better manners. What
  the button did before was serialise the API's own objects in the browser: a
  shape only Diluxite understands, which also had to fit in a tab's memory
  before it could be saved.

  The filenames are the careful part. A title is user data, so `../../etc/passwd`
  becomes a file inside the archive rather than a write outside it; the
  characters Windows refuses, the trailing dots it silently eats, and the
  reserved device names (`CON`, `LPT1`…) are all handled, because an export
  that unpacks on one of the three operating systems is not portable. Names
  that collide after that cleaning get ` (2)`, compared case-insensitively —
  `Reunión` and `REUNIÓN` are two live notes that land on one file on macOS and
  Windows. Trashed notes stay in Trash.

  The archive is verified in the test suite by **Python's `zipfile`**, not by
  the library that wrote it: a reader and writer from the same package agree
  with each other by construction, including on a malformed archive, and the
  only promise this endpoint makes is that other software can open it.

- **Admin → AI now answers whether semantic search is actually working.**
  `GET /api/admin/embeddings` reports which embedder is running (provider,
  model, host, dimensions, and whether it is semantic at all) next to what is
  actually stored in `chunks`, grouped by vector dimension. When they disagree
  the panel says so and offers the reindex that fixes it — the endpoint for
  that already existed and had no way in from the UI.

  This failure is silent by construction. Change the embedding model and every
  stored vector has the wrong dimension; pgvector then aborts the semantic half
  of a hybrid search with `different vector dimensions`, keyword search absorbs
  the query, and results keep coming back. The product quietly becomes
  keyword-only. Until now the only trace was a warning printed once, at boot,
  into the container log.

  Stored vectors are reported **grouped**, not sampled: a corpus half-way
  through a reindex holds two dimensions at once, which is exactly the state
  that breaks search for some notes and not others — and exactly the one a
  single-row probe calls healthy half the time. Chunks with no embedding at all
  are counted too; a provider that was down while notes were being saved leaves
  those behind, and no dimension check can see them.

  The panel also names the case an install lands in when nothing is configured:
  the deterministic provider reads as "local", which looks healthy. It hashes
  words into stable vectors — two ways of saying the same thing land as far
  apart as two unrelated sentences. It now says so.

  Choosing the provider stays an install-time decision (env vars on the `api`
  container): the model dictates the vector dimension, so switching is a data
  migration rather than a setting. What this adds is the pair that migration
  needs — see the mismatch, and rebuild from it. No secret crosses the HTTP
  boundary: the description has no field for one, and a test asserts the
  response never matches anything shaped like a credential.

- **WCAG 2.1 AA, measured in a browser and kept there** (`apps/web/e2e/a11y.spec.ts`).
  The app is audited with axe against the conformance set on every PR, across
  the states a single-page app actually has — note open, raw editor, command
  palette, settings dialog, and each activity-bar view — because a violation
  introduced inside a dialog is invisible to a scan of the screen behind it.

  The graph view and a 320px viewport are covered too — the width WCAG 1.4.10
  (reflow) names, which is an AA criterion in its own right and is also where
  contrast tends to break.

  There were already axe checks running in jsdom, and they were green. jsdom
  has no layout and no styles, so it structurally cannot see colour contrast
  or focus order, which is most of what AA is about. Four real failures were
  waiting behind that green:

  - **critical** — the command palette's input advertised `aria-controls`
    pointing at a list that was only rendered while open, so a combobox was
    announced as controlling an element that did not exist. The panel is now
    always mounted and `hidden` when closed.
  - **serious** — the dockview tab put a real `<button>` inside an element
    that is itself `role="tab"` with `tabindex="0"`. The ✕ is now decorative
    (a span, hidden from assistive technology, there for the mouse) and the
    keyboard path is Delete / Backspace on the tab, which dockview's own tab
    strip already implements including roving focus to the neighbour. Neither
    `tabindex="-1"` nor `aria-hidden` would have fixed this: a negative
    tabindex is still focusable.
  - **serious** — CodeMirror marks its content `role="textbox"` and had no
    name to give it, so a screen reader announced the note body as an
    unlabelled edit field.
  - **serious** — a timestamp in the timeline sat at 3.8:1 against its
    background. The design token already meets AA; an ad-hoc `/80` opacity on
    top of it is what broke it.

- **Search configuration belongs to the organization, not to a browser**
  (migration 0026). `searchMode` and `topK` lived in each browser's
  `localStorage` while the control for them sat in the **admin console** — so
  an administrator configured their own laptop believing they had configured
  the organization. The tab said so in small print; now it does what its
  placement always claimed.

  They join `org_settings`, which is already one row per org and already
  sparse. `GET` is open to any member (the client needs the defaults it will
  search under), `PUT` is an admin action, and both are audited. The org value
  is the **default** — a request that names a mode still gets it.

  `topK` is bounded at both ends, in the database and at the route: it feeds a
  candidate multiplier, so an unbounded value turns one query into a very
  expensive scan for everyone in the org. The two dead browser preferences are
  gone rather than left to drift.

- **API errors answer in the reader's language, and carry a stable code.**
  Resolved from `Accept-Language`, with base-language fallback (`es-AR` → `es`,
  `pt-BR` → `pt`) and English for anything unsupported, because a
  half-translated error is worse than a consistent one.

  This is user-visible, not cosmetic: the web renders `body.error` straight to
  the person on the login screen, the password reset and the forgot-password
  flow — so a Spanish speaker was reading English at the exact moment
  something had gone wrong.

  Every response now also carries `code`. That is the part a client should
  branch on: string-matching a message breaks the moment the wording improves,
  and breaks once per language.

  **Every English string is byte-identical to what the endpoint returned
  before**, which is what made the migration additive — 548 integration tests
  passed without one assertion being touched. Two catalog tests keep it
  honest: every key must exist in all six locales, and every translation must
  keep the same `{placeholders}` as the English, since a translation that drops
  `{role}` loses the one thing the reader needed.

- **Search actually reranks now.** The last stage of the pipeline was
  `IdentityReranker`, a documented no-op: RRF fused the keyword and vector
  rankings and then nothing reordered them. `LexicalReranker` is the default,
  and it weighs what RRF structurally cannot see — RRF discards scores, so the
  fused order cannot know whether a document contains the query as a phrase,
  covers every term, or matches in the title.

  **Measured, not asserted.** A new Spanish evaluation suite — fixed corpus,
  ten queries, the note each should return — gives `hit@1 = 0.90` and
  `hit@3 = 1.00`, against `hit@1 = 0.70` with reranking off. Both numbers are
  produced by a test that runs the suite through each reranker, so the claim
  stays checkable rather than becoming folklore.

  No model: every feature is countable and every weight is written down, so a
  bad ranking traces to a number. The `Reranker` port stays open for a
  cross-encoder, and `IdentityReranker` remains as the honest way to turn
  reranking off.

  Titles now reach the reranker. A chunk is a slice of the body, so the one
  place a note says what it is about was invisible to the stage judging
  aboutness.

- **Tables inside notes answer as facts** (ADR-001 step 2, migration 0025).
  A table is read as rows at save time — derived like tags and wikilinks,
  never authored — and a question naming one of its keys gets the exact value
  **above** the prose, with the note and line it came from:

  ```
  FACTS (exact, from tables):
  • MRR · Valor: 42k — Métricas del trimestre:7
  ---
  1. Métricas del trimestre …
  ```

  **Composed, never fused.** RRF discards scores, which is what makes it right
  for combining BM25 with cosine distance and wrong here: averaged into the
  prose ranking, an exact answer lands third behind two paragraphs about the
  topic — the answer the reader came for, lost.

  **The lane runs on every query and no classifier decides.** It costs one
  indexed lookup beside an embedding call already being paid for. A classifier
  guessing whether a question "looks factual" would fail silently — it says
  prose, the prose answers plausibly, and the exact row sits unread. The
  space's own keys decide instead.

  **A table earns fact status; it is not given it.** A repeated key, a blank
  key, a single column or fewer than two rows means the table is skipped, and
  the extractor says which. The asymmetry is the reason: a missing exact
  answer costs a fallback to prose, which is where the system was anyway,
  while a wrong one is served above the prose, labelled as fact, and believed.
  Key matching is whole-token for the same reason — `MRR` must not fire on
  `MRRs`.

- **A stale note says so in the editor.** `⚠ last changed 240d ago · usually
  every 30d`, in the note header, in all six locales. It renders **only** when
  there is something to say: nothing for a note within its rhythm, and nothing
  when no cadence was measured at all — absent is not the same as fresh, and a
  reassuring badge for it would be the UI claiming something never checked.

  Freshness ships on the notes **list** as well as the detail, which is a bug
  found by opening the app rather than by the suite: the web reads notes out of
  the list payload, so a field present only on `GET /api/notes/:id` was wired
  in the API and invisible in the product. Every integration test passed and
  the badge did not render. Pinned by a test now.

- **Search results say how they are ageing, in their own rhythm** (ADR-002).
  Every result carries a freshness assessment, and `search_memory` turns it
  into a sentence the calling model reads out: *"last changed 240 days ago,
  about 8.0x its usual 30-day cadence — treat as unconfirmed"*.

  The verdict is relative to the entity's OWN measured cadence, never to the
  calendar. Two notes last touched the same day get opposite answers when one
  changes yearly and the other weekly — a fixed "older than 90 days" rule
  flags the stable architecture note and clears the metrics table that went
  stale last week, which is backwards.

  **It stays quiet when there is nothing to say.** A caveat on every line is
  one nobody reads, which costs exactly the cases where the caveat mattered.

  Where an entity has no cadence yet — one change is a point, not an interval
  — a **structural** prior stands in, and the answer says it is leaning on one
  rather than claiming a cadence it never measured. The prior keys off shape
  rather than subject because that is what the evidence supports: on Wikipedia
  a lead sentence has a 46-day median shelf life against 3,740 days for an
  infobox field.

  One batch query for the results actually returned. No model anywhere in this
  path: *"why is this stale?"* has to answer with a count, which is checkable,
  not a judgement, which is not.

- **Provenance, validity and rank on every note** (ADR-002, migration 0024).
  Two tables keyed by `(entity_kind, entity_id)` — not by `note_id`, so a table
  row becomes an entity when `query_facts` lands and reuses them unchanged:
  - `entity_provenance` carries the three axes, each from an existing standard.
    **W3C PROV-O**: the Agent a write is attributed to, the Activity it came
    through, and what it was derived from. **SQL:2011 bitemporal**:
    `valid_from`/`valid_to` for the world's timeline and `recorded_at` for
    ours, kept apart so "what did we believe in March" stays answerable rather
    than only "what is true now". **Wikidata ranks**: `preferred` / `normal` /
    `deprecated`, where superseding closes the window and keeps the row.
  - `entity_change_stats` carries how often something *actually* changes — an
    EWMA over its own edit intervals, folded in on save in constant time. **No
    scheduled job and no pass over the corpus**; staleness is a subtraction at
    query time. ~20 MB at 500k notes.

  The hook lives in `DrizzleNotesRepository`, beside the version history and
  for the same reason: with collab on, typing never reaches `NotesService`.
  A retitle or a move amends provenance but does **not** advance the change
  count — the note is not saying anything different, and counting it would
  teach the estimator a cadence the note does not have.

  Each surface declares its own attribution: `rest`, `mcp`, `import:ddw` (with
  the repo and path it was built from). **The collab flush declares `unknown`,
  and that is a finding rather than a shortcut** — a flush carries whatever was
  typed during the ~2s debounce, which can be several people's edits merged by
  the CRDT. Naming one of them would be inventing provenance, which is the
  failure the record exists to prevent.

  Both tables carry the standard space-member RLS policy, asserted rather than
  assumed: they describe who wrote what and when, which is arguably more
  sensitive than the note body.


- **Note version history.** Every content-changing save snapshots what the
  note used to say (`note_versions`, migration 0023, standard space-member
  RLS). Two valves keep it bounded: a 5-minute coalescing window (a burst of
  saves — collab flushes every ~2s — mints one snapshot) and a 100-versions
  per-note cap pruned oldest-first. New REST surface:
  `GET /api/notes/:id/versions`, `GET /api/notes/:id/versions/:versionId`,
  `POST /api/notes/:id/versions/:versionId/restore` — restore is a NEW save
  on top, so history is append-only. In the note header, the History button
  opens the list with a rendered preview and one-click restore.

### Fixed

- **Partitions had no Row-Level Security of their own.** Postgres does not
  inherit policies to partitions: the policy on `chunk_embeddings` protected a
  query through the parent and did nothing for one naming the partition —
  measured at 0 rows against 58. Only privileged code names partitions today,
  which is why it was not exploitable, but "nothing does yet" is not a
  security property. Every partition now carries its own.

- **The embedding provider is chosen from the admin console** — Admin → AI.
  Provider, model, endpoint and dimensions, stored in the database and winning
  over the environment, so a choice survives a restart instead of being one.
  **Amazon Bedrock** joins Ollama, Azure and the deterministic fallback: it
  authenticates with a bearer API key, so it needs no AWS SDK and no SigV4.

  The form's job is not to collect four fields. It is to stop the one click
  that quietly breaks search:

  - **Saving does not switch anything.** The new vector space is registered
    empty and the live model keeps answering until a reindex fills it — said
    on screen before the click, and confirmed with what will happen rather
    than a generic "are you sure". A change that does not touch the vector
    space — an endpoint typo — asks nothing, because a needless confirmation
    is how people learn to click through the ones that matter.
  - **Test before you trust.** One round trip that catches a wrong key, a
    mistyped endpoint, a model that does not exist, and the one nobody
    expects: a model that answers with a different number of dimensions than
    you asked for, which would index cleanly and fail on every search.
  - **It says where your notes go.** Choosing Azure or Bedrock sends the text
    of every note to Microsoft or AWS to be turned into vectors. For a
    company's second brain that is a business decision, so it is on the screen
    rather than in a document nobody opens.

  The API key is stored **encrypted** (AES-256-GCM, per-secret scrypt key) and
  never comes back out — not the plaintext, not the ciphertext. An edit that
  does not retype it keeps it, because a UI that sends "unchanged" as an empty
  value erases the credential the first time somebody fixes a typo.

  The passphrase lives in the environment (`DILUXITE_SECRET_KEY`, falling back
  to the existing signing keys). There is deliberately **no random fallback**,
  unlike the CSRF and MFA keys: those lose in-flight tokens on restart, this
  would make every stored credential permanently unreadable. Without one, the
  console says so and refuses to store a credential rather than writing it in
  the clear.

- **Row-Level Security is engaged** — [ADR-004](docs/adr/adr-004-engaging-rls.md),
  migration 0028. The policies have been in this schema since migration `0003`
  and had never once applied: the API connects as the container's superuser,
  which is exempt from RLS even with `FORCE ROW LEVEL SECURITY`, and the helper
  that would publish the caller's identity was never called. Isolation rested
  on one layer.

  Now the data plane of every request runs as `diluxite_app` — no superuser, no
  `BYPASSRLS` — with `app.current_user_id` published, so Postgres refuses
  cross-tenant rows on its own. **A route that ships without its guard is no
  longer a leak.**

  Proven rather than asserted: `rls-enforced.integration.test.ts` mocks the
  application guards **open** and shows a second organisation still reads
  nothing — through REST, search, the export and MCP. It is the only test that
  can tell "RLS is engaged" from "RLS exists", and it fails when either half of
  the wiring is removed.

  Three decisions worth knowing:

  - **No new credentials.** `SET LOCAL ROLE` needs membership, not a login, so
    the migration grants the role to whoever the application connects as.
    Verified against a non-superuser owner. `install.sh`, compose and existing
    deployments need nothing but the migration.
  - **The scope is per repository method, not per request.** Diluxite calls an
    embedding model on every save and every semantic search — 100 ms to 2 s —
    and a request-long scope would park one of ten pooled connections for the
    duration. Measured at +2.4 ms per scoped operation, with zero connections
    left `idle in transaction` while a model call runs.
  - **Nobody has to remember it.** An `AsyncLocalStorage` scope and two
    proxies; the twenty repositories and every route handler are unchanged.

  What stays privileged, on purpose and written down: **authentication**, because
  resolving a Bearer token means reading `tokens` whose policy asks who the user
  is — circular by construction; the **audit log**, because a policy silently
  dropping an entry is the worst failure an audit log has; and the **collab
  write path**, because a debounced save is a CRDT merge of several people's
  edits with no single identity to publish. Those are one layer, and the docs
  say so.

  If the role cannot be assumed, the API says so at boot. The failure mode is
  otherwise invisible: an instance that cannot enforce RLS looks exactly like
  one that does.

- **The embedding model is a row, not an assumption** — [ADR-003](docs/adr/adr-003-embedding-model-lifecycle.md),
  migration 0027. `embedding_models` records which model is live, with a
  partial unique index that makes **Postgres itself** refuse a second active
  one. Vectors move out of `chunks` into `chunk_embeddings`, partitioned by
  model: each partition pins its dimension and carries an **ordinary HNSW
  index** — the first vector index this project has been able to have, because
  the shared free-dimension column could never support one.

  Two silent failures close with it:

  - **Semantic search was a sequential scan.** Every query compared against
    every vector. Measured: 98.6 ms against 4.3 ms at 20,000 vectors.
  - **Nothing recorded which model produced a vector.** Swapping two models
    that share a dimension mixed old and new vectors, search returned
    nonsense, and the health check — which compared dimensions — reported
    everything fine. The health endpoint now reports per model, and a test
    covers exactly that swap.

  The vector space travels with the **embedder**, not with a global flag: a
  search reads back from the space it wrote into. Filing vectors under
  whichever model a flag called active is how they end up meaningless, and an
  earlier draft of this change did precisely that — caught by the collab suite.

  Existing installations carry across automatically at boot, once and
  idempotently. `chunks.embedding` is deliberately left in place so the change
  is reversible; a later migration drops it.

  Two tests exist because the obvious versions of them proved nothing. One
  captures the SQL the repository **actually sends** off the wire and explains
  that, after a hand-written EXPLAIN shaped like it stayed green with the
  `model_key` filter removed. The other asserts the planner *chooses* the
  index, since an index it never picks reads as "we have an index" and performs
  like a scan.

- **[ADR-003](docs/adr/adr-003-embedding-model-lifecycle.md) — one live embedding
  model, and a model change nobody notices.** Changing the embedding model
  invalidates every stored vector, and it happens once or twice a year. The
  schema is built around that sentence: a catalogue where a partial unique
  index makes Postgres itself refuse a second active model, embeddings moved
  out of `chunks` into a table partitioned by model — each partition with a
  pinned dimension and an **ordinary** HNSW index — and a change that runs
  blue/green: build alongside, dual-write, atomic flip, reversible if the new
  model searches worse.

  At most two models ever exist, live plus the previous one for rollback, and
  anything older is dropped **inside the transaction that activates the new
  one**, so it cannot be forgotten. Five changes leave two models; fifty leave
  two.

  Measured, not assumed: 98.6 ms sequential scan against 4.3 ms with the index
  at 20,000 vectors; partition pruning confirmed on the query plan; RLS
  verified on the partitioned table with an unprivileged role; retiring a model
  is a 10 ms `DROP TABLE` rather than a mass delete that leaves the table
  bloated.

  The alternative — keep today's free-dimension column and let models coexist
  permanently, each with a partial index — was measured too, and rejected in
  the ADR: it turns a state that should last hours into the permanent shape of
  the schema. Coexistence is a migration, and the schema should say so.

  This lands **before** the UI for choosing a model, which without it is a
  button that silently breaks search: today nothing records which model
  produced a vector, so swapping two models of the same dimension mixes them
  and the health panel reports everything fine.

- **A suite that proves one installation isolates its organisations** —
  `apps/api/src/cross-org-isolation.integration.test.ts`. The attacker is not a
  stranger: it is a **super_admin of another organisation**, the most
  privileged account a tenant can hold. Every tenant-scoped route is probed —
  workspaces, notes, versions, folders, trash, graph, stats, export, members,
  search, org settings, tokens, audit, auth policy, embeddings, reindex — plus
  the MCP tools, which are the surface the product exists for.

  Two properties keep it honest. A test compares the probe table against the
  app's own route table, so a new tenant-scoped route **fails the suite** until
  it is audited rather than shipping unnoticed. And each probe rejects a 404
  that came from Fastify's router rather than from an authorisation check — a
  wrong URL in a probe is the easiest way to write an isolation suite that
  tests nothing.

  The answer it returns: nothing crosses — with one measured exception. `users`
  is global by design (one account can belong to several organisations) and is
  the only tenant-adjacent table with no RLS, so the CSV import, which upserts
  by email, lets an admin of one organisation rewrite the **first and last
  name** of a person in another. The suite asserts that, and asserts
  everything that does not move with it: the password hash, the active flag,
  the account id, the memberships, and the fact that the same caller is still
  refused the other organisation's notes on the next request. Recorded in
  `MULTI-TENANT.md` and on the roadmap as a 1-2 hour fix.

  60 tests, each falsified by removing the guard it depends on.

- **A suite that asks whether the features are on screen** — `apps/web/e2e/features.spec.ts`.
  Every other suite asks whether a unit behaves. This one asks the question
  that kept getting answered wrong: is the thing we built visible in the
  product, and does it do anything? Reading view, autosave state, history with
  restore, the freshness supply, search from the palette, both admin panels,
  and the export download — one shallow assertion each, through the UI a
  person uses.

  It exists because the freshness badge shipped twice with a green suite and
  was invisible both times: the field was on `GET /api/notes/:id` while the web
  reads its notes from the LIST payload, so nothing failed anywhere. That is
  the assertion the suite makes about freshness — that the list carries it —
  rather than the tempting one about a badge being absent, which would pass
  just as happily with the field gone.

- **Two authorisation loose ends, and a lesson from closing one.**

  `POST /api/notes/delete-many` answered `200 {deleted: 0}` to a caller who
  could touch none of the notes — a success code for a request that was
  entirely refused, indistinguishable from "there was nothing to delete". It
  now answers 403 when nothing was allowed, and reports `refused` alongside
  `deleted` when only part was. Partial success stays a 200 deliberately:
  failing a twenty-note selection because one was out of reach is worse than
  deleting the nineteen and saying so.

  The CSV user import upserted by email with no scope, so an admin of one
  organisation could rewrite the first and last name of somebody in another.
  It now touches people in the caller's organisation, people who do not exist
  yet, and accounts that belong to no organisation at all — somebody else's
  person is skipped and counted.

  **The lesson.** The first version of that check used the ordinary
  repository, and RLS made it blind: inside the request scope the policies
  answer *"which organisations can I see"*, not *"which organisations does
  this person belong to"*. For someone else's account that is nothing, and
  "nothing" read as "belongs to no one" inverted the check into permitting
  exactly what it exists to refuse. The lookup now runs privileged. An
  authorisation decision about somebody other than the caller has to run where
  the rows are readable — which is the auth plane ADR-004 already describes,
  arrived at from the other direction.

  A stricter first attempt also broke the import's own idempotency (this
  endpoint creates accounts without adding a membership, so "must already be a
  member" made re-running the same CSV a no-op). Both were caught by tests
  within a minute of being written, which is the entire argument for the
  isolation suite existing.

- **A repeated note title answers 409, not 500.** Live titles are unique per
  workspace (migration 0020, so following a wikilink twice cannot race into two
  notes), but the unique violation escaped as `internal server error` — which
  tells the caller nothing about the one thing they can change. Found while
  writing the export's filename-collision test.

- **Closing a tab no longer offers to delete the note.** The explorer binds
  Delete document-wide to delete the selected note, and opening a note selects
  it there — so pressing Delete on a tab closed the tab and popped
  "Delete 1 item?" behind it, one keystroke from destroying the note you meant
  to stop looking at. The shortcut now fires only when the tree has the focus,
  or when nothing does, which is the rule every file manager follows.

  Found by writing the test for the tab-close keyboard path above: the first
  version of that test passed with the fix reverted, because the note was
  being deleted out from under it.

### Changed

- **The multi-tenancy documentation now says what runs.** It claimed two
  independent layers, application and Postgres Row-Level Security, and that
  "even if someone bypasses the code guard, the DB still rejects rows the user
  isn't entitled to". That second layer is built but **not engaged**: the API
  connects as the container's superuser — exempt from RLS even with `FORCE ROW
  LEVEL SECURITY` — and `withIdentity`, the helper that would publish
  `app.current_user_id`, is never called. The policies are real and proven
  correct against a purpose-made unprivileged role; they simply never run in a
  shipped installation.

  Nothing is less safe than it was yesterday — the application layer is a
  single door shared by REST, MCP and collab, and the suite above is what it
  is worth. But a security claim that overstates the posture is worse than one
  that does not, especially in a public repository. `MULTI-TENANT.md` and
  `SECURITY.md` now describe the layer that runs, and
  [Engaging RLS](docs/MULTI-TENANT.md#engaging-rls-the-second-layer) lists what
  switching the other one on actually costs — a second Postgres role, an
  upgrade path for existing installs, `withIdentity` threaded through the
  repositories, and a privileged path for three auth tables whose RLS is
  currently deny-all.

  Also removed a stale line promising a separate "Diluxite Cloud" private repo.
  There is one product.

- **A note opens in the reading view.** The note body is now ONE mode at a
  time: the rendered Markdown reading view by default (an empty note opens
  straight in the editor), and the `</>` toggle switches the whole body to
  the raw CodeMirror editor. The split preview is gone — with it the Eye and
  orientation toggles, the splitter, and the `previewLayout` /
  `previewSplitPct` preferences (Settings → Editor no longer offers a
  preview picker).

- **Smart autosave + the editor says whether it saved.** There is no Save
  button and there never was a reliable cue: now the draft saves itself
  ~4s after the last keystroke (blur still flushes as a backstop — saving
  no longer requires the counter-intuitive "click outside"), and the editor
  header narrates it: "Unsaved…" → "Saving…" → "Saved ✓". With collab
  CONNECTED the header shows "Live sync ✓" and the autosave timer doesn't
  run at all — the CRDT channel already persists every ~2s, so a REST save
  on top (times N people typing) would be pure duplicate traffic.

- **Restore respects the live collab doc.** Restoring a version now goes
  through the same server-edit path as PUT/MCP writes: the live Y.Doc (and
  every connected editor) adopts the restored text immediately. Before, the
  restore wrote the DB behind the live doc's back — it looked like nothing
  happened and the next collab flush silently reverted it (found live). The
  panel also adopts the restored text instantly instead of waiting for a
  refresh that lags the flush. While typing in live-sync mode the header now
  says "Syncing…" (settling to "Live sync ✓" when you pause) — it read
  "Live sync ✓" mid-keystroke, which felt like typing wasn't registering.

- **Version history records at the write door.** The snapshot hook lives in
  the Drizzle notes repository's `update` — not in the service — because
  the collab mirror persists through the repository directly; a
  service-level hook missed the most common save path (found live: edits
  through the editor left no history).

- **Brought every dependency up to its latest patch/minor.** Runtime:
  `fastify` 5.8.5 → 5.12.1, `@fastify/helmet` 13.1.1, `@modelcontextprotocol/sdk`
  1.30.0, `jose` 6.2.10, `openid-client` 6.8.7, `nodemailer` 9.0.5,
  `@simplewebauthn/server` 13.3.3, `yjs` 13.6.32. Web: `react`/`react-dom`
  19.2.8, `lucide-react` 1.17 → 1.34, `marked` 18.0.11, `i18next` 26.4.0,
  `react-i18next` 17.0.12, the CodeMirror packages, `tailwindcss` 4.3.3,
  `vite` 8.2.2. Tooling: `vitest` 4.1.11, `eslint` 10.9.1, `typescript-eslint`
  8.68.0, `playwright` 1.62.1, `tsx` 4.23.12. Majors were deliberately left
  out of this sweep.

- **Pinned `@codemirror/state` and `@codemirror/view` to a single copy.**
  CodeMirror compares classes by identity, so two copies in the tree fail to
  typecheck and misbehave at runtime — and the `lang-*`/`autocomplete`/
  `language` packages still request the older line. The pin lives with the
  other overrides in `pnpm-workspace.yaml`.

- **`vitest.config.ts` → `vitest.config.mts`.** The file is ESM but the root
  package has no `"type": "module"`, so Vite loaded it as CommonJS and warned
  that its next major will stop doing so. The extension says what the file is
  and the warning is gone.

- **Took the majors that hold: `dockview-react` 6 → 8, `@fastify/rate-limit`
  10 → 11, `jsdom` 29 → 30, `@testing-library/jest-dom` 6 → 7, `@types/node`
  25 → 26, `@types/nodemailer` 7 → 8.** Two of them changed behaviour rather
  than just versions:
  - dockview 8 hands `onDidActivePanelChange` a `{ panel, origin }` event
    where 6 handed over the panel itself, so `panel.id` read `undefined` and
    activating a tab silently stopped driving the route — the editor swapped
    panes while the URL and the explorer highlight stayed behind. Fixed, and
    `apps/web/e2e/dock-tabs.spec.ts` now guards it in a real browser (verified
    against the broken version, not just the fixed one).
  - jest-dom 7 no longer drags the Node globals in transitively, which is what
    `apps/web/tsconfig.json` had been relying on without saying so. `node` is
    now in its `types` list explicitly, since that project also typechecks the
    `@diluxite/core` sources it imports and those use `node:crypto`/`Buffer`.

- **Dropped the dead `poolOptions` from the Vitest config.** Vitest 4 removed
  it, so `{ forks: { singleFork: true } }` was being read by people and ignored
  by the runner. `fileParallelism: false`, already there, is what pins the
  integration projects to one worker in the current API.

- **Dropped Node 20 from the supported matrix.** Node 20 reached end-of-life in
  April 2026; the CI matrix is now `[22, 24]` and `engines.node` is `>=22.13`
  (also the floor pnpm 11 needs). Node 24 (active LTS) remains the Docker
  runtime; Node 22 (maintenance LTS) stays as the supported floor.

### Security

- **The workspace role is now enforced on every surface, not just REST.** A
  `viewer` could create, edit, move and delete notes through **MCP**, and could
  type into a live document over the **collab WebSocket**, while the identical
  account got a 403 from the web app. The collab socket additionally ignored
  org-token scopes entirely, so a token minted read-only — the safe default —
  could have edited over the socket, the one surface where REST's `write`
  scope check did not reach.

  The cause was structural rather than a typo: the rule lived as a closure
  inside `buildApp`, so the other two surfaces each re-implemented "may this
  identity touch this space" and each stopped at bare membership. It now lives
  once in `@diluxite/core` (`space-authz.ts`) as `canReadSpace` /
  `canWriteSpace`, and REST, MCP and collab all call it — a new surface gets
  the behaviour by construction instead of by remembering.

  A reader on the collab socket is **connected read-only**, not refused: a
  viewer watches the note change live and cannot type into it, because the role
  means read-only, not "cannot look".

  Covered by 15 unit tests on the rule itself and 9 integration tests that pin
  each door actually calling it, including two real-WebSocket cases. The collab
  test was checked against the reverted fix and fails there — an earlier
  version of it did not, because it waited less than the ~2s persistence
  debounce and was asserting on an empty write either way.

- **Triaged all 28 open CodeQL alerts; fixed the 12 that hold.** The verdict and
  the reasoning for every one, including the accepted ones, is in
  `docs/ddw/reports/codeql-triage-2026-08-28.md`.

  The one that mattered was a **polynomial ReDoS on the forgot-password route**
  (`js/polynomial-redos`): the email pattern put a literal dot between two
  quantifiers whose class already contains the dot, so an address with no dot
  after the `@` made the engine try every split. It runs on the request body,
  where Fastify's 1MB default is the only bound, from an unauthenticated
  endpoint. The same pattern had been copied into three files; all three now
  call one `isEmailShaped()` in core, and the fix is a **length guard** (RFC
  5321's 254 octets) rather than a smarter regex — that bounds the cost however
  the pattern is later edited.

  Also fixed: the ambiguity in `bearerToken`'s `/^bearer\s+(.+)$/i`, the
  quadratic trailing-slash strip in `cf-access.ts`, the MCP session map (a
  plain object keyed by a client-supplied header — `sessions['__proto__']`
  returned `Object.prototype`, now a `Map`), an unescaped recipient in the noop
  email logger, and rate limits on four routes that earn them: both TOTP
  enrolment endpoints (a 6-digit code is brute-forceable even behind a
  session), `/related` (a vector scan) and `/append` (a write plus a re-index).

  Nine `missing-rate-limiting` alerts on ordinary authenticated CRUD are
  accepted with reasons, as are two genuine false positives — the MFA token's
  HMAC is not a password hash, and the TOTP `if (code)` dispatches between
  verification paths rather than guarding one.

- **Closed the nine open Dependabot advisories.** All of them arrived through
  `@modelcontextprotocol/sdk`'s dependency tree or the web bundle, and all are
  pinned the same way the previous sweep pinned its own: `hono` ≥4.12.34
  (ReDoS in the CORS middleware, `memo()` retaining SSR output across requests,
  algorithmic-complexity DoS in the Language middleware, and the Proxy helper
  keeping hop-by-hop headers), `@hono/node-server` ≥1.19.15 (path traversal in
  `serve-static` on Windows), `body-parser` ≥2.3.0 (DoS on an invalid `limit`),
  and `esbuild` ≥0.28.1 (arbitrary file read through the dev server).
  `dompurify` is a direct dependency and goes to 3.4.14, which fixes both the
  `IN_PLACE` hook removal leaving a detached subtree executable and the
  `CUSTOM_ELEMENT_HANDLING` bypass of `afterSanitizeElements`. `pnpm audit`
  is clean for prod and dev.

- **Cleared the dependency audit (0 HIGH/CRITICAL on the published images).**
  Pinned patched versions of transitive advisories via `pnpm-workspace.yaml`
  overrides: `fast-uri` ≥3.1.4, `find-my-way` ≥9.7.0, `ip-address` ≥10.3.1,
  `brace-expansion` ≥5.0.7, `nanoid` ≥3.3.16, `postcss` ≥8.5.18, and bumped
  the existing `undici` pin to ≥7.29.0. Each stays within the already-installed
  major, so no consumer breaks.

- **Removed every package manager from the runtime images.** The published
  `api` and `all-in-one` images no longer ship npm or corepack/pnpm: the runtime
  launches the API with plain `node --import tsx` instead of `pnpm exec tsx`, and
  the Dockerfiles `rm -rf` the npm and corepack trees. This eliminates the
  image-only advisories that lived in corepack's vendored pnpm bundle (`tar`
  CVE-2026-59873 CRITICAL, the `pnpm` ACE CVE-2026-55697, and the recurring
  `glob` / `minimatch` / `brace-expansion` / `ip-address` findings) at the
  source — no version-chasing, no `.trivyignore` for them. pnpm still runs the
  install/build in the (discarded, never-scanned) builder stage. Overrides live
  in `pnpm-workspace.yaml` and esbuild's build script is allowed there
  (`allowBuilds`), as pnpm 11 requires.

### Not taken, with reasons

- **`@hocuspocus/*` stays at 2.15.3 (4.6.0 available).** The migration itself
  is small and was carried out in full, then reverted: every integration test
  driving a REAL WebSocket failed while all eight going through
  `openDirectConnection` passed. Reduced to a probe containing no Diluxite
  code — a bare `new Server({ onLoadDocument })` and a 4.6.0
  `HocuspocusProvider` over `ws` — the client document stayed empty and not one
  status event fired. This is the same "connected, not synced" failure
  diagnosed against an early 4.x, still present at 4.6. The reasoning is in
  `apps/api/src/collab.ts` so the next attempt starts from the evidence.

- **`typescript` stays at 6.0.3 (7.0.2 available).** `typescript-eslint` 8.68
  refuses to load against TS 7 — it throws on import, so `pnpm lint` does not
  run at all. The upstream workaround is a second TypeScript in the tree for
  the linter's benefit; a repo whose lint gate is `--max-warnings=0` should not
  buy a passing gate with a duplicate compiler. Tracked upstream at
  typescript-eslint#10940.

## [1.0.0-alpha.62] — 2026-06-09

**HTTPS no longer fails silently.** Closes the bug where `install.sh` configured
Caddy with ACME for any domain (including `/etc/hosts` overrides and private
domains), leaving the user with a `tlsv1 alert internal error` in the browser
and no hint of what to do.

### Added

- **DNS pre-flight check** in the HTTPS wizard step. Before generating the
  Caddyfile and bringing Caddy up with ACME, `install.sh` resolves the domain
  against a public resolver (`dig @1.1.1.1`), bypassing `/etc/hosts`. On
  NXDOMAIN or a private IP (RFC1918 / loopback / link-local), it shows a
  3-option menu: cancel HTTPS, use `tls internal` (Caddy's local CA), or
  continue with ACME under a big warning.
- **`HTTPS_TLS_MODE`** persisted in `.diluxite-install.env` with two values:
  `acme` (default, ACME via Let's Encrypt) or `internal` (Caddy generates its
  own local CA — works offline / for fake domains).
- **`install.sh --reconfigure-https`**: non-interactive shortcut that jumps
  straight to the HTTPS submenu (without going through the parent
  `--reconfigure`).
- **Management menu item 8**: "Reconfigure HTTPS — change domain or TLS mode
  (ACME / internal / off)". Same flow as the flag.
- **`install.sh --export-caddy-ca [--out FILE]`**: extracts Caddy's local root
  CA (when the mode is `internal`) to a `.crt`, with macOS / Linux specific
  instructions on how to import it into the OS keychain.
- **Post-install healthcheck detects ACME failures.** When HTTPS is enabled,
  after `docker compose up` it runs `curl -k` against the HTTPS endpoint. If
  there is no response within 60s, it prints a clear warning with the probable
  cause (`docker logs diluxite-caddy`) plus the fix command
  (`install.sh --reconfigure-https`).

### Changed

- **Caddyfile template** now branches on `HTTPS_TLS_MODE`. The `internal` mode
  adds the `tls internal` directive. ACME stays the default — back-compat for
  existing installs.
- **Reconfigure submenu**: option 3 (HTTPS) now goes through
  `reconf_https_menu`, the same flow as the flag — domain + DNS check + mode
  picker. Previously it only changed the domain + ACME email without
  validating.
- **i18n**: new `MSG_HTTPS_CANCELLED` string in EN / ES / PT for the
  cancellation flow. `M_M8` item added in all 3 languages.

### Tests

- 5 new E2E cases in `test/installer/run.sh` ([26-30]):
  - `--reconfigure-https` with a public domain → picks ACME directly.
  - `--reconfigure-https` with NXDOMAIN → 3-option menu → user picks `tls internal` → Caddyfile contains the directive.
  - `--reconfigure-https` with a private IP → user cancels → no Caddyfile, clean state.
  - Management menu item 8 shows "Reconfigure HTTPS".
  - `--export-caddy-ca --out FILE` writes a valid PEM and prints import instructions.
- New `test/installer/bin/dig` mock driven by the `DLX_DIG_RESULT` env var.
- `docker` mock extended to fake the Caddy container and return a fake PEM
  on `docker exec diluxite-caddy cat /data/caddy/...`.

### Migration / Breaking

None. The `HTTPS_TLS_MODE` default of `acme` preserves existing behavior.
Old installs keep working untouched — the state file is filled in
automatically on the next `--reconfigure` or re-render.

## [1.0.0-alpha.61] — 2026-06-08

### Changed

- **Demo seed: a heavily-linked root note + trashed notes.** The seed now adds a
  root-level (no folder) **"Knowledge Hub"** note wired with **50 outlinks** and
  **50 backlinks** (50 notes link out from it, 50 link back in) so the Neighbors
  panel has a real fan-out example, and soft-deletes **10** notes so the Trash
  view isn't empty. Verified end-to-end (50 / 50 / 10).

## [1.0.0-alpha.60] — 2026-06-08

### Changed

- **Neighbors as an accordion when docked to the side.** In the fixed sidebar the
  three groups (Outlinks / Backlinks / Suggested) stack vertically as an accordion
  — clicking one expands it and collapses the others, one at a time. The stacked
  footer keeps the tab bar. Both share the same active-group state.

## [1.0.0-alpha.59] — 2026-06-08

### Fixed

- **The editor/preview divider wouldn't drag.** The preview splitter passed its
  bounds as percentages (20–80) while a host-relative splitter reports pixels, so
  every drag got clamped to 80px and snapped the split to the minimum. Bounds are
  now in pixels and the handler clamps the resulting % — dragging works in both
  side-by-side and stacked layouts. Added a Splitter drag regression test.

## [1.0.0-alpha.58] — 2026-06-08

### Added

- **Neighbors panel can dock to the side.** New **Editor → Default neighbors
  panel** picker (Don't show / Fixed sidebar / Stacked, with the same visual mock
  as the preview picker) controls whether the backlinks / outlinks / suggested
  panel opens by default and where. The panel now renders either as a resizable
  right sidebar or the stacked footer; the per-note toggle restores your last
  placement. (Width persists separately from height.)

### Fixed

- Removed the last dead **"My Space"** reference — the status-bar item now just
  shows the current workspace name (it used to open a settings tab that no longer
  exists).

## [1.0.0-alpha.57] — 2026-06-08

### Changed

- **Settings tidy-up.** Removed the redundant "Connect AI" tab; renamed
  "MCP connection" → **"AI Connection (MCP)"**. New **Editor** tab to set the
  default Markdown preview (editor-only / side-by-side / stacked) with a visual
  picker. Language stays under Appearance. Removed the dead "Manage workspace"
  Welcome link (the settings tab it pointed to was gone).
- **AI Connection: a Copy button** for a freshly minted token, and revoking a
  token now requires an explicit **confirmation** (like every other key action).
- **Security tab is disabled with an explainer in local mode.** Passkeys / 2FA /
  password only apply in server mode; local single-user installs now show a lock
  banner instead of letting you poke controls that return 403/404.
- **Admin → Members: role changes and removal are disabled in local mode** (one
  user, nothing to manage) with a note pointing to server mode.

### Tests

- **Real coverage pass** (v8): raised line coverage on the genuinely-thin spots —
  `with-identity` (RLS boundary, was 0%), passkey-verify rejection branches
  (35%→67%), `UpdateBanner` show/hide/dismiss logic, and the admin tabs
  (Workspaces / OrgMembers / SearchConfig / ApiKeys). Honest note: overall
  statement coverage is ~62%; big canvas components (GraphView), entrypoints and
  UI primitives remain intentionally light.
- **Coverage audit pass** — filled the genuine gaps found by an import-level scan:
  - db: `password-resets-repository` (was zero-coverage; create / findActiveByHash
    / expiry / markConsumed / deleteExpired) and `passkeys-repository`
    (single-use + wrong-kind challenge isolation, register + per-user listing).
  - web: `dismissedRelated` (per-note persistence, scoping, corrupt-storage
    tolerance) and `useIsMobile` (breakpoint match + reactive change).
  - Confirmed the rest of the flagged modules are already exercised (db repos via
    the api/rls integration suites; UI primitives via the components that use them).

## [1.0.0-alpha.56] — 2026-06-08

### Fixed

- **Deep-linking to `/trash` did nothing.** The route→view sync omitted `trash`,
  so opening the URL directly left you on the Explorer (clicking Trash in-app
  worked because it took a different path). Added `trash` to the sync and to the
  active-view highlight, plus a regression test.

### Changed

- **Account menu: removed "My Space", added "About".** The workspace shortcut
  left the account popover; a new **About** entry opens the About tab and shows
  the current release **channel** (`next` / `latest`), inferred from the running
  version.

## [1.0.0-alpha.55] — 2026-06-08

### Added

- **Tags open the full Search.** Typing `#tag` in the top bar (or clicking a
  `#tag` on a note) now offers **"Search all notes with #tag"** and lands on the
  Search panel seeded with it — every match, not the top bar's truncated dropdown.
- **VS Code-style preview tabs.** A note you open but don't edit is a transient
  *preview* tab; opening another **replaces** it instead of piling up. Editing the
  note **pins** it so it stays. Keeps the tab bar tidy.

## [1.0.0-alpha.54] — 2026-06-08

### Fixed

- **Restore from trash returned HTTP 400.** Action-style POSTs from the browser
  (restore, TOTP enroll, …) send `content-type: application/json` with no body,
  and Fastify's default parser rejected the empty body with 400. The server now
  treats an empty JSON body as `{}`. Added a regression test that reproduces the
  exact request the browser makes (the previous trash test used `inject` without
  that content-type, so it never hit the failing path).

### Changed

- **Neighbors panel — coherent and manageable.** Outlinks and Backlinks are now
  alphabetically-sorted lists (not loose chips) with a **filter box** once they
  pass 8 items — essential when a note has hundreds of backlinks. Every outgoing
  link (resolved *or* missing) has a **× to remove** it. The Suggested tab badge
  now matches the list exactly (relevant count), there's no arbitrary cap, and
  the footer reports how many notes fell **below the relevance bar** rather than a
  misleading "weaker hidden".

## [1.0.0-alpha.53] — 2026-06-08

### Added

- **Neighbors panel: real link management + coherent suggestions.**
  - **Unlink** an outgoing link straight from the panel (× on the chip): it
    removes the `[[link]]` but keeps the words, so the graph edge goes away
    without losing text.
  - **Suggested notes are relevance-gated.** Instead of always filling a fixed
    top-10, only genuinely-close notes show (above a relevance threshold, capped,
    best-first), each with a **relevance %**. You can **dismiss** a suggestion so
    it never comes back (remembered per note). Weaker matches collapse into a
    "+N hidden" hint. No more "everything links to everything".

## [1.0.0-alpha.52] — 2026-06-08

### Fixed

- **Duplicate notes from "create missing link".** Double-clicking a missing
  wikilink target (e.g. `tdd`, `event sourcing`) raced the optimistic insert and
  created several identical empty notes. Creation is now coalesced per title
  (single-flight) and the existing-note lookup is case-insensitive, so one click
  — or ten — yields exactly one note.

### Changed

- **Installer: every action ends with a clear, consistent closing.** `Update` now
  waits for the stack to become healthy, reports the real running version, and —
  like `status`, `reconfigure` and `seed` — prints an "open it now → URL" line, so
  you always know an action finished and where to go.

## [1.0.0-alpha.51] — 2026-06-07

### Added

- **Languages: Português, Italiano, Català and 中文** (Chinese, Simplified) join
  English and Español — 6 locales total. The language selector now shows each
  option in its own language. A **"Reset to defaults"** button restores the
  appearance preferences.

### Fixed

- **Language switch did nothing.** `useSettings` was per-component state, so
  changing the language in Settings never reached the `useT()` hook elsewhere.
  It's now a shared store (`useSyncExternalStore`) — every consumer reacts to
  changes (language, theme, accent).
- **Accent color now actually works.** The setting wrote a dead `--brand` var
  that nothing read; it now drives `--c-brand` (the real UI accent — buttons,
  active rows, links, highlights) plus a derived hover shade. Added a helper
  text explaining what it affects.
- **Explorer highlight follows the active tab.** Activating a note via its tab
  (not only via the explorer row) now updates the route, so the explorer keeps
  the current note highlighted and you don't lose your place.
- **Theme-aware scrollbars** (`color-scheme` + a subtle themed thumb) instead of
  the OS default that looked out of place in dark mode.

### Tests

- `useSettings` shared-store tests (cross-consumer updates, accent → `--c-brand`,
  reset, native language labels) and a `Splitter` regression test.

## [1.0.0-alpha.50] — 2026-06-07

### Fixed

- Web: the editor/preview split divider is now visible at rest in both light and
  dark mode (a subtle 1px hairline using the theme line color), instead of only
  appearing on hover. The 4px drag area and the brand-tinted hover/drag highlight
  are preserved.

## [1.0.0-alpha.49] — 2026-06-07

### Added

- **Demo-data seeding from the menu** (`install.sh` → option 7, or `--seed`):
  loads demo notes even when Diluxite is already installed. If there are
  **multiple workspaces** (server mode, or a restore with several users) it
  **lists org · owner · space · notes** and lets you choose which one to load
  into, and how many. This fixes the old seeding problem where it picked "the
  first space" at random — now `scripts/seed-demo.ts` accepts
  `DILUXITE_SEED_SPACE_ID` and targets exactly the chosen one.
- `install.sh` on a machine **without a prior installation**: after the Step 1
  checks it now asks **Install / Restore / Exit** instead of going straight to
  the wizard. "Restore" asks for the backup path and bootstraps it from scratch
  (mode/embedder/domain/secrets/cert travel with the backup) — the same flow as
  `--restore --in`, but discoverable from the interactive menu.

### Fixed

- `install.sh` uninstall: reordered to **confirm first**, then back up, then
  bring the stack down (previously it asked about the backup before confirming,
  and the main confirmation with default No fell through to a confusing "no
  changes"). Clearer messages (`Uninstall cancelled`, `Bringing the stack
  down…`).
- `install.sh` uninstall now **always removes the installation artifacts**
  (`docker-compose.yml` / template / Caddyfile / `.diluxite-install.env`) —
  previously it left them behind and a re-run detected a **"phantom"
  installation** and showed the management menu instead of the wizard. "Delete
  data" only controls the data directory; `backups/` and unrelated files (the
  user's cron) are left untouched.
- **Restore** now behaves like a full installation: if the backup uses
  **Ollama**, the installer **gets it ready** (installs it if missing + starts
  the daemon + pulls the model) instead of just warning; and on completion it
  runs the **health check + the same final summary** as the wizard.
  `ensure_ollama`/`wait_healthy`/`print_summary` extracted to be shared between
  install and restore.
- Reconfigure → switching the embedder to **Ollama** now also **gets it ready**
  (installs + pulls the model), consistent with install/restore.
- **Auto-update is now OPT-IN (default OFF) with a double warning + a maintained
  image.** It used to be ON by default with `containrrr/watchtower`, which was
  **archived (Dec 2025)** and crashes on Docker ≥29 (`client version 1.25 is too
  old`). Now: (1) the prompt is opt-in `[y/N]`; (2) if you say yes, it warns that
  it is **NOT for production** + that Watchtower mounts the **Docker socket =
  root on the host**, and requires explicit confirmation; (3) it uses the
  maintained fork **`nickfedor/watchtower`** (Apache-2.0). Applies to both the
  wizard and reconfigure.
- **Improved status** (`install.sh --status`): the container list now shows only
  the useful columns (NAME · IMAGE · SERVICE · STATUS · PORTS, without
  COMMAND/CREATED); adds **System** (OS + Docker version), **MCP** (endpoint for
  Claude/Copilot), **Workspaces** (count), and a **warning if any container is
  restarting / unhealthy / exited** (e.g. a broken Watchtower).
- **Prompt consistency** in `install.sh`: all yes/no prompts use `y/n`
  (previously it mixed `s/n` in Spanish/Portuguese), with the standard convention
  **uppercase = default** (`[Y/n]` = Enter is yes · `[y/N]` = Enter is no). The
  management menus now show their default `[0]` in brackets, just as the wizard
  shows `[1]`.
- `install.sh` uninstall → "delete data" **now actually deletes**: the Postgres
  files are owned by root (uid 999), so the user's `rm` failed and, with
  `set -e`, **aborted the uninstall** (leaving data + artifacts behind). It now
  uses an ephemeral container as a fallback and never aborts.
- **Fresh installation over a path with old data**: previously it silently
  reused the existing Postgres database (the seed went to an old workspace and
  the UI showed previous data). Now the wizard **detects** the existing database
  and asks whether to **reuse** (keep your notes) or **start fresh** (wipe).

### Tests

- **Installer e2e suite** (`test/installer/`, `pnpm test:installer` + the
  `installer-test.yml` workflow): drives the `install.sh` lifecycle with
  `docker`, `curl`, and `ollama` **mocked** — install (wizard) → detect → menu
  (which loops) → status/update (`pull` consistency) → **mode-aware** reconfigure
  → **local→server switch** (promotion + password scrubbed with no plaintext) →
  backup (contents) → **uninstall → clean re-run** ("phantom" regression) →
  **Install/Restore/Exit fork** → restore (incl. **Ollama prepared** + final
  summary) → reconfigure **channel / auto-update / HTTPS / OIDC / trusted-header
  / embedder** → **reset-admin** → **server→local** → **Cloudflare Access** (env
  in compose) → **install over existing data** (prompts reuse/start fresh) +
  **uninstall deletes the data** (uid-999) → **seed with target space**. **55
  assertions** (+ a `seed-target` integration test that verifies the notes land
  in the chosen space). `install.sh` honors `DILUXITE_TTY` to feed input via pipe
  in tests.

## [1.0.0-alpha.48] — 2026-06-07

**Cloudflare Access auth with verified signature + installer management mode.**

### Added

- **Cloudflare Access (signed JWT)** — new `CfAccessJwtAuthProvider`
  (`apps/api/src/cf-access.ts`) that verifies the `Cf-Access-Jwt-Assertion`:
  **RS256** signature against the team certs
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) + **AUD** +
  issuer + expiration. The trust is cryptographic, so it **does not require
  forcing all traffic through a tunnel** — a spoofed request that reaches the
  port without a valid signature is rejected. Opt-in via
  `DILUXITE_CF_ACCESS_TEAM_DOMAIN` + `DILUXITE_CF_ACCESS_AUD`.
- **Modular auth chain** in `services.ts` (server mode): session/Bearer →
  Cloudflare-Access-JWT (if configured) → plain trusted-header (if configured,
  with an isolation warning). Each layer exists only if its env var is set.
- **install.sh — management mode**: when it detects an existing installation (or
  via flags) it offers `update / reconfigure / status / backup / restore /
  uninstall / reset-admin`. An interactive menu that **returns to the menu**
  after each action (`0` exits only from the main menu). Non-interactive flags:
  `--update`, `--status`, `--reconfigure`, `--channel`, `--autoupdate`,
  `--backup [--out]`, `--restore --in`, `--reset-admin`, `--uninstall`,
  `--install-dir`, `-y`.
- **local↔server mode switch** with super-admin onboarding: promotes
  `local@diluxite` → the admin's email (preserving notes/space/org), with
  **bootstrap-then-scrub** of the password (the app hashes it with PBKDF2 and it
  is removed from the compose — no plaintext at rest). Sub-modes: Cloudflare-JWT
  / email+password / trusted-header.
- **Full backup + restore**: `pg_dump` + `docker-compose.yml` + Caddyfile +
  state + `manifest.json` + **Caddy TLS certificate**. The restore carries the
  mode/embedder/domain/secrets and can **bootstrap a new machine** (without
  asking; the config travels with the backup).
- Installation state persisted in `.diluxite-install.env` (no secrets).

### Changed

- `resolveIdentityByEmail` extracted into `@diluxite/core`, shared by
  TrustedHeader and Cf-Access.
- `install.sh status` shows the **actual running version** (via `/api/info`),
  not just the channel tag.
- Reconfigure is **mode-aware** (does not offer SSO/admin in local mode);
  configuration changes **no longer `pull`** images (same image); auto-update is
  **inferred from the compose** instead of assuming ON.

### Tests

- `cf-access.unit` (signature/aud/issuer/expiry/spoof/policy),
  `cf-access.integration` (Fastify e2e: forged→401, wrong AUD→401),
  `admin-promote.integration` (promotion preserves notes + super_admin + hash;
  reset-admin flow). Full suite green: 357 unit + 208 api integration.

## [1.0.0-alpha.47] — 2026-06-05

**Full settings cleanup + theme fix + explicit Save pattern.**

Three pieces of feedback from Pablo in one release.

### 1) Dark/light theme not applying (BUG)

`tailwind.config.ts` declared `darkMode: ['selector', '[data-theme="oscuro"]']`
and `styles.css` had `:root[data-theme='claro']` selectors — but the code in
`useSettings.ts` sets `root.dataset.theme = 'dark'` / `'light'` (in English).
Result: dark mode never matched the selector and the toggle did nothing
visible.

Fix:
- `tailwind.config.ts`: `[data-theme="dark"]`.
- `styles.css`: `:root[data-theme='light']` (3 places).
- All in English, consistent with the rest of the codebase.

### 2) Settings → Search and Settings → Space moved to Admin

Conceptually these were instance/org configuration, not user preferences. The
Settings modal shrinks to what IS per-user.

New admin components:
- `apps/web/src/shell/admin/SearchConfigTab.tsx` (section `search`): mode
  (Hybrid / Keyword / Semantic) + topK.
- `apps/web/src/shell/admin/CurrentWorkspaceTab.tsx` (section
  `current-workspace`): stats + JSON export of the active workspace.

Admin sidebar updated with the 2 new items. `AdminConsole` now receives
`prefs` + `setPref` (persistence is still localStorage for now; server-side in
alpha.48).

`SettingsModal` drops from 7 to 5 tabs:
**Connect · Appearance · MCP · Security · About**.

### 3) Explicit Save pattern

Until now `Appearance` and `Search` persisted live on every keystroke via
`setPref`. The user saw no Save button and had no "it was saved" feedback.
Changed to the explicit pattern:
- Local `draft` state mirrors the inputs.
- "Save changes" button disabled until there are changes.
- "✓ Saved" message after click.

Applies to `AppearanceTab` (in Settings) and `SearchConfigTab` (in Admin).
**One-shot actions (mint API key, revoke session, etc.) do NOT require Save** —
they are already explicit via their own buttons.

### Tests

`pnpm vitest run apps/web/src` → **187 green**. Typecheck clean in 4
packages.

### Pending (alpha.48)

- AI / Embeddings configurable from the UI (Ollama URL, model, provider
  switch). Today these are container env vars because the provider is injected
  at boot; changing it at runtime requires refactoring the provider factory + an
  admin endpoint + server-side persistence. If the model's dimension changes, a
  re-index is also needed (old chunks remain at a different dimension). We will
  tackle this as a separate piece.

## [1.0.0-alpha.46] — 2026-06-05

**Settings reorg — "AI / Embeddings" moves to Admin; "Security" consolidates 3 tabs into 1**.

The modal's Settings were growing (10 tabs) and mixed concepts of different
scope. Cleanup:

### `AI / Embeddings` moved to the Admin Console

The embedder is *instance* configuration (the model dictates the vector
dimension, which is fixed at the schema level) — it is NOT a user preference.
An `AiConfigTab` already existed in `AdminConsole.tsx` (section `ai`) with a
better UI than the one in Settings: it shows the active provider + the env vars
priority order (Azure → Ollama → fallback) + a full example.

- Removed `tab === 'ai'` from the SettingsModal type union, TAB_IDS, render.
- Deleted the `AiTab` function from the modal.
- Removed the `settings.tab.ai` entry from the 2 locales.
- `SETTINGS_TABS` in `App.tsx` updated.
- Zero loss of functionality: the Admin Console already had a better UI.

### Security tab consolidated

There used to be 3 separate tabs (`passkeys`, `twofactor`, `sessions`) — one per
auth mechanism. For the user it is a single concept: "how I log in and what
devices are connected".

New `apps/web/src/shell/SecurityTab.tsx`:
- A single "Security" tab in the nav.
- 3 collapsible sections (single-open accordion): Passkeys / 2FA / Sessions
  & password.
- Each section's header has a title + descriptive subtitle.
- Clicking the open one closes it (all collapsed is possible).
- Default: Passkeys open.
- Sub-components (`PasskeysTab`, `TwoFactorTab`, `SessionsTab`) intact — the
  wrapper mounts them conditionally. Their existing tests still pass.

### i18n

- `es`: `security: "Seguridad"` (replaces 3 entries).
- `en`: `security: "Security"` (replaces 3 entries).
- Removed `ai`, `passkeys`, `twofactor`, `sessions` from the
  `settings.tab.*` namespace.

### Tests (+5)

`SecurityTab.test.tsx` with mocked sub-components (Passkeys/2FA/Sessions use
`useApp()` and dragging them into the test would be noise — their dedicated
tests already cover the behaviour). Covers:
- The 3 sections render in the tree.
- Default Passkeys open.
- Click 2FA opens 2FA and closes Passkeys (single-open).
- Click Sessions opens Sessions.
- Click on the open section closes it.

Totals: **342 unit + 290 int = 632 green** (1 known flake from WorkspaceSelector
timing, passes in isolation). Typecheck clean.

Final Settings modal tabs: Connect · Appearance · Search · MCP · Space · Security · About (7, was 10).

## [1.0.0-alpha.45] — 2026-06-05

**i18n fix — missing translation keys for `twofactor` and `sessions`**.

When the `twofactor` (alpha.37) and `sessions` (alpha.39) tabs were added to
`SettingsModal`, the tab id was added to the `TAB_IDS` array but the
corresponding translation keys were NOT added in
`apps/web/src/locales/{en,es}.json`. Result: the nav showed
`settings.tab.twofactor` and `settings.tab.sessions` raw (i18next returns the
key when it finds no value).

Fix: added the 4 missing entries (2 languages × 2 keys):
- `es`: `twofactor: "2FA / Autenticador"` · `sessions: "Sesiones y password"`.
- `en`: `twofactor: "2FA / Authenticator"` · `sessions: "Sessions & password"`.

No code changes. Typecheck clean.

## [1.0.0-alpha.44] — 2026-06-05

**Installer port auto-detect — no more "port 5432 in use, aborting"**.

The old Step 1 check was over-cautious + wrong: it validated `3030`, `5173`,
and `5432` being free, but the template only publishes `:5173` to the host (DB
and API are internal to the compose network). Result: if you had another
Postgres running (Diluxone, Mug, whatever) the wizard bounced for no reason.

Now:

- Only `:5173` (the public web) is validated.
- If it is in use, it looks for the first free one from 5173 to 5223. It shows
  "port :5173 in use → using :5174" on screen.
- The chosen port (`WEB_PORT`) is propagated to the compose port mapping
  (`"${WEB_PORT}:5173"`), to the post-install health check
  (`http://localhost:${WEB_PORT}/api/update/check`), to the final banner
  (`→ http://localhost:${WEB_PORT}`), and to the default redirect URI of the
  inline OIDC prompt.
- Removed the `:3030` and `:5432` checks (unnecessary).
- If all 51 ports in the range are in use, only then does it abort with a clear
  message.

Changes only in `install.sh`. No automated tests (it is shell). Validated with
`bash -n install.sh` and manually: with `:5173` in use, the wizard advances to
`:5174` automatically.

## [1.0.0-alpha.43] — 2026-06-02

**Trash bin / soft delete for notes**.

One of the most requested things — `DELETE /api/notes/:id` was a hard delete
with no undo. Any user expects "oops, I deleted it by mistake" with an undo.

### Schema (migration 0016)

`notes.deleted_at timestamp NULL` + partial index `notes_active_idx
(space_id, updated_at DESC) WHERE deleted_at IS NULL`. NULL = active,
non-NULL = in trash. The column is additive — old installations work without a
backfill.

### Repo + service (notes-repository.ts + core/notes.ts)

All existing reads (`findById`, `findByTitle`, `list`) now filter
`deleted_at IS NULL`. New methods:

- `listDeleted(spaceId)` — for the trash bin UI.
- `restore(id)` — clears `deleted_at`. Re-indexes on restore so search finds the
  note again.
- `purge(id)` / `purgeTrashForSpace(spaceId)` — actual hard delete. Only works
  if the note was ALREADY in trash (defense in depth).
- `findByIdIncludingDeleted(id)` — for the restore/purge endpoints that need to
  resolve a soft-deleted note.

`delete` / `deleteMany` NOW perform a soft delete (an observable change —
documented in the CHANGELOG and the repo comment). The indexer drops chunks on
delete so search does not return trashed notes.

### Endpoints (apps/api/src/app.ts)

```
DELETE /api/notes/:id              → SOFT delete (behavior change)
GET    /api/spaces/:id/trash       → lists the workspace's trashed notes
POST   /api/notes/:id/restore      → restore (409 if not in trash)
DELETE /api/notes/:id/purge        → hard delete (409 if NOT in trash —
                                     you must soft-delete first)
DELETE /api/spaces/:id/trash       → empty trash (purge all of the space's)
```

Member auth on all of them. Strangers get 403/404 (no enumeration leak).

### UI

- New `TrashView.tsx` in `apps/web/src/shell/views/`. List, restore + purge
  per-row, "Empty trash (N)" footer. Uses `useDialogs.confirm` for destructive
  actions. Standard pattern `mutate → refresh + refreshAll` (PATTERNS §2).
- `ActivityBar` adds a "Trash" button between Recent and "+ New note". Trash2
  icon from lucide.
- Router: new `/trash` route.
- `api.ts` + `fakeApi.ts`: `listTrash`, `restoreNote`, `purgeNote`,
  `emptyTrash`. The fake keeps a parallel `trashed` Map to mirror the backend's
  contract.

### Behavior changes (soft breaking)

- `DELETE /api/notes/:id` was hard, now soft. **Recovery via `/restore`**. The
  old behavior (hard, no trash) is now reached via `/purge` (which requires
  being in trash first).
- `notes.list()` and `findById` exclude trashed rows. A user who had deleted
  notes in the old system sees them neither in the listing nor in the trash —
  they are hard-deleted. That is expected: the migration does not "revive" them.

### Tests (+13)

- `trash.integration.test.ts` (7): soft delete + list + GET trash; restore;
  restore of non-trashed = 409; purge requires trash; empty trash purges all;
  strangers 403; multi-delete moves all to trash.
- `TrashView.test.tsx` (6): empty state; populated list; restore call +
  refreshAll trigger; purge with confirm; purge cancel does not call; empty
  trash with confirm.

Totals: **341 unit + 290 int = 631 green**. Typecheck + lint clean.

### Pending (next session)

- **Backup/restore CLI** (`diluxite backup --out file.tar`): analysis started
  but left as a separate release. The RUNBOOK already documents the manual
  `pg_dump` flow. The native CLI wraps that + manifest.json with version +
  counts. I estimate 1 day.

[1.0.0-alpha.43]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.43

## [1.0.0-alpha.42] — 2026-06-02

**Forgot password / email reset + EmailProvider abstraction**.

Closes two ROADMAP items to reach beta. The email service is the foundation for
future SSO invites and audit alerts.

### Backend — EmailProvider abstraction

New `packages/core/src/email.ts`:
- Interface `EmailProvider { name, send(EmailMessage) }`.
- `NoopEmailProvider` — logs the message to stdout, never sends. Default when
  no SMTP is configured, ideal for dev (the reset link appears in
  `docker logs diluxite`).
- `SmtpEmailProvider` — adapter over a nodemailer-like transport. The transport
  is injected to keep nodemailer out of @diluxite/core's dep graph.

Wireup in `apps/api/src/services.ts`:
- `pickEmailProvider()` decides by env: `DILUXITE_SMTP_HOST` set → SmtpEmailProvider
  (port 587 default, opt-in STARTTLS via `DILUXITE_SMTP_SECURE=1`); otherwise Noop.
- Env vars: `DILUXITE_SMTP_HOST`, `DILUXITE_SMTP_PORT` (587),
  `DILUXITE_SMTP_USER`, `DILUXITE_SMTP_PASS`, `DILUXITE_SMTP_SECURE`,
  `DILUXITE_SMTP_FROM` (default `noreply@diluxite.local`).

### Schema (migration 0015)

`password_resets`:
- `id uuid PK · user_id uuid (cascade) · token_hash text unique · expires_at
  · consumed_at · requested_ip · created_at`.
- 2 indexes: by user_id (lookup) and by expires_at (sweep). UNIQUE on the hash
  covers the hot path.

### Endpoints

`POST /api/auth/forgot { email }`:
- **Always returns 200** — does not leak whether the email exists
  (anti-enumeration).
- If it exists: mints a random 32-byte token, persists the SHA-256 hash with a
  1h TTL, sends an email with the link `${publicWebUrl}/reset?token=${token}`.
  Audits `auth.password.reset_requested` only when the user exists.
- Rate-limit 5/min/IP (same budget as login).
- Minimal format-level email validation — silent failure (same 200).

`POST /api/auth/reset { token, newPassword }`:
- Lookup by `SHA-256(token)`, verifies not-expired + not-consumed.
- Hashes + persists the new password.
- Marks the token consumed (cannot be reused).
- **Revokes ALL of the user's sessions** (no current-cookie protection — the
  user is resetting because they lost access; sign-out other devices is the
  correct default).
- Audits `auth.password.reset_completed` with `{ sessionsRevoked }` or
  `auth.password.reset_failed` with `{ reason }`.
- Rate-limit 10/min/IP.

Both endpoints return 404 in local mode.

### Frontend

- `ForgotPasswordScreen.tsx` — full-page form. Submit shows "check your email"
  whether or not the account exists (mirrors the backend's no-leak).
- `ResetPasswordScreen.tsx` — full-page form with confirm password. Reads the
  token from `?token=` in the URL. Shows a "missing token" state if absent.
  Submit disabled until password ≥ 8 + match.
- `LoginScreen.tsx` — the "Forgot your password? Reset it from the host:
  docker compose exec api …" link was replaced with a real `<a href="/forgot">`.
- `AppGate.tsx` — pre-auth bypass for `/forgot` and `/reset?token=`. These pages
  render BEFORE the auth check, so the logged-out user sees them without the
  "Loading…" + LoginScreen flash.
- `api.ts` + `fakeApi.ts`: new methods `forgotPassword(email)` and
  `resetPassword(token, newPassword)`.

### New env vars

```
DILUXITE_SMTP_HOST=smtp.your-provider.com
DILUXITE_SMTP_PORT=587
DILUXITE_SMTP_USER=...
DILUXITE_SMTP_PASS=...
DILUXITE_SMTP_SECURE=1                              # TLS-on-connect (465 style)
DILUXITE_SMTP_FROM=noreply@diluxite.your-domain.com
DILUXITE_PUBLIC_WEB_URL=https://diluxite.acme.com   # for the reset link
```

### Tests (+19)

- `packages/core/src/email.test.ts` (7): Noop logs + truncates; Smtp passes the
  correct fields to the transport + `from` override + propagates errors.
- `apps/api/src/forgot-password.integration.test.ts` (10): user exists + email
  sent; user does not exist + silence; invalid email + silence; hash NOT plain
  in DB; audit recorded; 404 in local mode; reset works end-to-end (password
  change + revokes sessions + token consumed); replay rejected; bad token 400;
  password short 400; audit success + failure.
- `apps/web/src/shell/ForgotPasswordScreen.test.tsx` (4): initial render,
  empty-submit error, success view with the echoed email, real error surfaces.
- `apps/web/src/shell/ResetPasswordScreen.test.tsx` (5): missing-token UI,
  render with token, submit disabled until valid, done view, error surfaces.

Totals: **335 unit + 283 int = 618 green** (up from 589). Typecheck + lint
clean.

### Breaking change

None. The screens are additive; the endpoints live under new `/api/auth/*`; the
default email provider is Noop (no SMTP required).

[1.0.0-alpha.42]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.42

## [1.0.0-alpha.41] — 2026-06-02

**Stabilization: CSV import flake + core docs refresh + lint cleanup**.

### Flake fix — `UsersImportCsv.test.tsx`

The only test that was missing "confidently green" — it passed in isolation but
failed under CPU load. Root cause: `user.type()` with long strings (multi-line
CSV with `{Enter}` keystrokes) drops characters under load.

Fix: a new `pasteCsv(value)` helper in the test that uses `fireEvent.change`
(atomic, no timing). The component receives the textarea from a real "paste", so
the helper matches the user gesture's intent better than simulated keystrokes.
Applied to the 7 tests that passed long CSV.

Bonus: `apps/web/src/fakeApi.ts` passed `parseUsersCsv` via dynamic import
(`await import('@diluxite/core')`) — Vite 8 + workspace deps have issues with
dynamic imports in tests. Changed to a static import (simpler, faster, no
per-call resolution overhead).

10 consecutive runs of the file: 10/10 green.

### Lint cleanup

Removed 2 `// eslint-disable-next-line react-hooks/exhaustive-deps` that
pointed at a rule that is NOT installed (`eslint-plugin-react-hooks` is not in
the config). They were pre-existing lint errors in `SessionsTab.tsx` and
`TwoFactorTab.tsx`. Replaced with a normal comment explaining the intent (do not
re-fetch when the refresh function identity changes).

### Docs refresh (heavy drift detected in a prior session)

- **`docs/ARCHITECTURE.md`** — fully rewritten to the actual state: stack
  up to date (Vite 8, Vitest 4, Tailwind 4, React 19, Node 24), the 14 DB
  migrations documented with their origin (alpha + number), Yjs collab as its
  own section (§10), audit log (§11), multi-backend auth (§7), an exhaustive env
  vars table (§13). Previously the last date was 2026-05-27, pre alpha.10.
  Without this a new contributor got confused by an old stack.
- **`docs/RUNBOOK.md`** — fully rewritten: corrects the old clone URL
  (`soydiloreto/diluxite` → `soydiloreto/diluxite-core-alpha`), documents the
  new install.sh wizard (9 steps with HTTPS Caddy + OIDC + trusted-header
  inline), adds operational sections (audit log retention, active sessions,
  password change, 2FA), an expanded troubleshooting table with real cases
  (Watchtower not updating, OIDC callback fail, HTTPS Caddy cert fail).
- **`docs/PRD.md`** — updated §19 "Current state" with real numbers (589 tests,
  stack up to date). Explanatory note at the top pointing to §20 for enterprise
  hardening (alpha.21-40). The central body remains as history of the v4.0
  engine (intentionally — the §20 appendix covers everything new).

### Tests

Still **316 unit + 273 int = 589 green**. Typecheck clean. Lint with no
warnings.

[1.0.0-alpha.41]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.41

## [1.0.0-alpha.40] — 2026-06-02

**Password change endpoint + session invalidation (Phase #51)** — the last
"high priority" gap in SECURITY.md falls.

### Endpoint

`POST /api/auth/password { currentPassword, newPassword }`:
- Requires an active session.
- Verifies `currentPassword` with verifyPassword(stored_hash). 401 + audit
  `auth.password.change_failed` on mismatch.
- 400 if `newPassword` < 8 chars or equal to current.
- Hashes + persists the new password.
- **Revokes all of the user's sessions except the current cookie's** (with the
  cookie absent, revokes all).
- Returns `{ ok: true, otherSessionsRevoked: N }`.
- Audits `auth.password.changed` with `{ otherSessionsRevoked }`.
- Rate-limit 5/min per IP (same budget as login).

### UI

`SessionsTab` now contains a `password-section` above the table:
- Inputs: current password, new password (min 8), confirm.
- Client validation: match + ≥8 chars before POST.
- Button disabled until current is filled and new ≥ 8.
- The success message includes "signed out N other device(s)" when applicable.
- Server errors (wrong current password, etc.) in role=alert.

API client: `changePassword(current, next)` with CSRF via `POST()`.

### Tests (+12)

`password-change.integration.test.ts` (7 tests):
- 400 missing fields / too short / equal to current.
- 401 wrong current + audit failure event.
- 200 OK → DB has the new hash (direct verifyPassword test) + current cookie
  survives + others revoked + audit success event with metadata.
- No cookie revokes ALL.
- 404 local mode.

`SessionsTab.test.tsx` (+5 tests to the existing describe block):
- Form renders.
- Submit disabled until filled + valid.
- Confirm mismatch error.
- Success clears form + shows message with N others.
- Server error wrong current is surfaced.

### SECURITY.md gap closure

I marked the following gaps closed in docs/SECURITY.md §8:
- ✅ Sessions not invalidated on password change (alpha.40).
- ✅ No limit on concurrent sessions (alpha.39 — UI mitigation).
- ✅ No HTTPS by default (alpha.33 — Caddy sidecar).
- ✅ No 2FA TOTP (alpha.36+37).
- ✅ Bearer tokens never expire (alpha.20+).
- ✅ No audit log (alpha.34+35).
- ✅ No rate limit on /api/auth/login (alpha.21).
- ✅ No explicit CSRF token (alpha.32).

The only gap left is "No rate limit in general" (DoS by flood) and "Local mode
trusts whoever can reach port 5173" — both are "by design" for self-host and are
documented, not closed with code.

Totals: **316 unit + 273 int = 589 green**. Typecheck clean.

## [1.0.0-alpha.39] — 2026-06-02

**Active sessions UI (Phase #50)** — list and revoke connected devices.

Closes the "No limit on concurrent sessions" gap in SECURITY.md §8: the user now
sees ALL active sessions on their account and can revoke any they do not
recognize, in addition to the classic "sign out of all other devices" after
detecting a compromise.

### Schema (migration 0014)

`sessions` adds:
- `ip text` — IP captured when the session is created.
- `user_agent text` — the client's User-Agent.
- `last_seen_at timestamptz` — touched on every authenticated lookup.

Index `sessions_user_last_seen_idx (user_id, last_seen_at DESC NULLS LAST)` so
the UI's list is O(log n) without a full-table sort.

### Repo

`DrizzleSessionsRepository` extended:
- `createSession(userId, ttl?, {ip, userAgent})` — optional metadata.
- `findUserIdBySession()` bump-touches `last_seen_at` async (best-effort).
- `listActiveForUser(userId, currentToken?)` returns `ActiveSession[]` with a
  `current:bool` marker computed via SHA-256(currentToken) match against
  `token_hash`.
- `revokeForUser(userId, sessionId)` — defense in depth, requires a user match.
- `revokeAllForUser(userId, exceptToken?)` — sign out of all other devices.

### Endpoints

- `GET /api/auth/sessions` → `{ sessions: ActiveSession[] }`. Reads the cookie
  to identify the current session.
- `DELETE /api/auth/sessions/:id` → revokes if it belongs to the user (404 if
  not).
- `POST /api/auth/sessions/revoke-others` → revokes all but the current cookie's;
  with no cookie revokes EVERYTHING. Returns `{ revoked: N }`.

New audit events: `admin.session.revoked`, `admin.session.revoked_all_others`.

Login flow modified to pass ip+userAgent to `createSession` in all 4 paths:
password, OIDC callback, TOTP step 2, passkey sign-in.

### UI

New `sessions` tab in SettingsModal. `SessionsTab.tsx` with:
- A table with Device (truncated UA + `(this device)` marker), IP, Last seen,
  Expires, Revoke button.
- The current session highlighted with bg-brand-soft and NO Revoke button
  (logout is the correct path from here).
- "Sign out of all other devices" button visible only when there is ≥1
  non-current session.
- Empty / loading / error states.
- API client: `listActiveSessions`, `revokeSession`, `revokeOtherSessions` with
  CSRF headers.

### Tests (+18 new)

- `sessions-endpoint.integration.test.ts` (8 tests):
  * GET filters by user (no cross-user leak).
  * GET marks `current:true` only on the cookie's row.
  * DELETE :id revokes own / 404 for another's.
  * POST revoke-others kill all-except-current / kill-all with no cookie.
  * 404 in local mode.
  * Audit events recorded.
- `SessionsTab.test.tsx` (10 tests):
  * Render with rows, empty state.
  * Current marker visible, no Revoke on the current row.
  * Click Revoke → revokeSession + refresh.
  * Sign-out-others button appears / disappears depending on whether there are
    others.
  * Sign-out-others → revokeOtherSessions + refresh.
  * IP + UA visible, null → em-dash.
  * List error and revoke error in role=alert.

Totals: **311 unit + 266 int = 577 green** (1 UsersImportCsv timing flake passes
in isolation). Typecheck clean.

## [1.0.0-alpha.38] — 2026-06-02

**Audit log retention + test script fix.**

### Retention (Phase #49)

New env var `DILUXITE_AUDIT_RETENTION_DAYS`. When set to an integer > 0, an
internal job runs every hour and deletes events with `at < now() - N days`. Off
by default — SOC 2 typically expects ≥365d, GDPR data-minimization 90d; this is
left to the operator's discretion.

`DrizzleAuditEventsRepository.deleteOlderThan(date)` (new). Cast ISO+timestamptz
to avoid the postgres-js Date binding bug (`ERR_INVALID_ARG_TYPE`).

`apps/api/src/audit-retention.ts` — `startAuditRetention(repo, {retentionDays, intervalMs?, now?})`:
- Returns a no-op handle if retentionDays <= 0.
- Sweeps hourly by default.
- Errors during delete are logged without crashing the loop.
- `timer.unref()` so as not to pin the event loop.

Wireup in `apps/api/src/index.ts` — at startup, if
`DILUXITE_AUDIT_RETENTION_DAYS > 0`, it starts the sweeper with a log
"🧹 Audit retention: N days".

### Test script fix

`pnpm test:unit` now includes `--project api-unit` (it was missing —
mfa-tokens + audit-retention were left out-of-band).

### Tests (+9)

- `audit-retention.unit.test.ts` (6 tests): no-op, runOnce cutoff math,
  interval triggers, an error during delete does not crash, stop() cancels,
  logging of positive deletes.
- `audit-events.integration.test.ts` (+3 tests): deleteOlderThan strict <,
  future deletes everything, past deletes nothing.

Totals: **300 unit + 258 int = 558 green** (1 UsersImportCsv timing flake passes
in isolation). Typecheck clean.

## [1.0.0-alpha.37] — 2026-06-02

**2FA TOTP UI** — closes Phase #48 with a complete front-end.

### Settings → Two-factor authentication

New `twofactor` tab in SettingsModal (apps/web/src/layout/SettingsModal.tsx).
`TwoFactorTab.tsx` component with three visible states:

1. **Disabled**: "Enable 2FA" button → calls `/api/auth/totp/enroll`.
2. **Enrollment in progress**: shows the secret + an `otpauth://` link (scannable
   as a QR by authenticator apps) + a 6-digit input. Passes an input filter to
   accept digits only.
3. **Enrolled**: shows a `backupCodesRemaining` counter + a "running low"
   warning when ≤3 remain + a Disable button.
4. **Backup codes view**: after a successful verify-enroll, lists the 10
   plaintext codes in a 2-col grid + a "Copy to clipboard" button + Done. SHOWN
   ONLY ONCE — after that they are never shown again.

### Login screen MFA step

`LoginScreen.tsx` modified to handle the `{requiresMfa, mfaToken}` response from
the server. When it arrives:
- Hides the password + passkey + OIDC buttons (they do not apply with MFA
  pending).
- Shows the `login-mfa-form` with a 6-digit code input + a "Sign in" button.
- A "Use a backup code" toggle changes the input to 16-char hex and submits it
  as `backupCode` instead of `code`.
- Errors are shown inline; the form persists for retry.

### API client

`apps/web/src/api.ts` extended:
- `login()` can now return `{ ok: true; user }` OR `{ requiresMfa: true; mfaToken }`.
- New `loginTotp(mfaToken, {code | backupCode})`.
- New `totpStatus()`, `totpEnroll()`, `totpVerifyEnroll(secret, code)`, `totpDisable()`.
- Bonus: `logout` now also includes `csrfHeaders()` (latent fix — previously it
  could not complete the logout with CSRF active).

`fakeApi.ts` with fixtures: `totpStatus` always `enabled:false` in local mode,
`totpEnroll` returns a demo secret, `totpVerifyEnroll` returns 3 fake backup
codes.

### Tests (+18 UI)

- `TwoFactorTab.test.tsx` (10 tests): disabled/enrolled/enroll-in-progress
  states, button enabling, non-numeric filter, success → backup codes view,
  "running low" warning, disable + refresh, error in role=alert (totpStatus +
  verifyEnroll).
- `LoginScreen.test.tsx` (8 tests, +4 new): the full MFA path: switch to the
  MFA form, submit code → loginTotp with `{code}`, toggle to backup → submit
  with `{backupCode}`, error → stays on the MFA form.

Totals: **278 unit + 255 int = 533 green** (1 UsersImportCsv flake passes in
isolation). Typecheck clean.

### Phase #48 closed

Backend (alpha.36) + UI (alpha.37). Nothing pending. 2FA stands as a 3rd login
option alongside passwordless (passkey) and SSO (OIDC), configurable per-user
from Settings.

## [1.0.0-alpha.36] — 2026-06-02

**2FA TOTP backend (Phase #48)** — RFC 6238 + backup codes + login flow integrated.

Enterprise-baseline for deploys that need defense beyond the password. Passkeys
already covered this gap but require modern hardware and WebAuthn support; TOTP
works with any authenticator app (Google Authenticator, 1Password, Authy, Entra
Authenticator) and is what compliance most typically asks for.

### Core (`packages/core/src/totp.ts`)

Pure RFC 6238 implementation:
- `generateTotpSecret()` — 160 bits random, base32-encoded (matches the authenticator URI standard).
- `generateTotpCode(secret, now?)` — HMAC-SHA1, 30s period, 6 digits.
- `verifyTotpCode(secret, supplied, now?)` — accepts ±1 time-step for clock drift; normalizes
  padding and trim; constant-time compare; rejects non-numeric.
- `buildOtpauthUrl({issuer, accountName, secret})` — the URI that goes into the QR so the
  user's app recognizes "Diluxite (you@example.com)".
- `generateBackupCodes(N=10)` — N hex codes of 32 bits each + their SHA-256 hashes.
- `hashBackupCode(code)` — case-insensitive, trim-tolerant.

### Schema + repo

`migration 0013` adds `totp_secrets(user_id PK, secret, confirmed_at, backup_codes[])`.
The row ONLY appears after a successful verify-enroll — pending secrets are not persisted.

`DrizzleTotpRepository` with `getForUser`, `enroll` (idempotent upsert), `consumeBackupCode`
(atomic single-use), `deleteForUser`.

### mfaToken — password→TOTP handoff

`apps/api/src/mfa-tokens.ts` — opaque HMAC token `<userId>.<exp>.<mac>` with a 5-min TTL.
Binds userId to the signing key → it cannot be substituted. Signing key:
1. `DILUXITE_MFA_SIGNING_KEY` env var (recommended).
2. Derived from `DILUXITE_ADMIN_PASSWORD`.
3. Random fallback with a warning (does not survive restarts).

### Endpoints

- `POST /api/auth/login` (modified): if the user has TOTP enrolled, returns
  `{requiresMfa: true, mfaToken}` and does NOT set cookies. The client collects
  the code and POSTs to `/login/totp`.
- `POST /api/auth/login/totp` (new, rate-limited 5/min): accepts `{mfaToken, code}`
  or `{mfaToken, backupCode}`. Verifies; if OK sets session+CSRF cookies. If it
  fails, audits `auth.totp.failed`. Exempt from the CSRF gate (there is no
  session yet).
- `POST /api/auth/totp/enroll`: returns `{secret, otpauthUrl}` to show the user
  with a QR. The secret is NOT persisted yet.
- `POST /api/auth/totp/verify-enroll`: confirms with `{secret, code}`; if OK
  persists + returns 10 backup codes in plaintext (show ONCE).
- `DELETE /api/auth/totp`: deletes the row + audits `admin.totp.disabled`.
- `GET /api/auth/totp/status`: `{enabled, backupCodesRemaining}`.

### New audit events

- `auth.totp.failed` (with method=code|backup).
- `admin.totp.enrolled`.
- `admin.totp.disabled`.
- `auth.login.success` with `method: 'totp'` or `'totp+backup'` when logging in via 2FA.

### Tests (+50 new)

- `packages/core/src/totp.test.ts` (28 tests):
  * Generation/verify happy path.
  * Same-window same-code, distinct windows distinct codes.
  * ±1 step accepted, ±2 rejected.
  * Non-numeric rejected, padding normalisation, trim tolerance.
  * Cross-secret rejection.
  * otpauthUrl shape + URL-encoding.
  * Backup codes uniqueness + hash roundtrip.
  * hashBackupCode case-insensitive + trim.
  * **RFC 6238 known-answer vectors** (3 vectors from Appendix B).
- `apps/api/src/mfa-tokens.unit.test.ts` (8 tests):
  * Mint shape, accept fresh, reject malformed/expired/tampered/userId-sub.
  * Key isolation between signing keys.
  * Admin password fallback.
- `packages/db/src/totp-repository.integration.test.ts` (8 tests):
  * Roundtrip enroll → getForUser.
  * Re-enroll replaces atomically.
  * consumeBackupCode unknown/known/single-use/no-row.
  * deleteForUser.
- `apps/api/src/totp-endpoint.integration.test.ts` (13 tests):
  * Enroll → verify-enroll → status green.
  * Wrong code → 401, no persist.
  * Missing fields → 400.
  * Status enabled=false without a row, enabled=true with remaining count.
  * Disable deletes + audits.
  * Login → requiresMfa when 2FA is on, no cookies.
  * /login/totp with a valid code → cookies + ok.
  * /login/totp with an invalid code → 401 + audit.
  * /login/totp with a corrupt mfaToken → 401.
  * Backup code works and is consumed (not reusable).
  * Local mode always returns enabled=false.

Totals: **264 unit + 255 int = 519 green**. Typecheck clean in 4 packages.

### Pending (Phase #48 part 2)

- UI Settings → Security tab with QR + enrollment flow + backup codes list.
- Login UI: when the server returns `requiresMfa`, show input + verify.

I'll do those in alpha.37+.

## [1.0.0-alpha.35] — 2026-06-02

**Audit log full coverage** — extends recording to the rest of the sensitive endpoints.

Building on alpha.34 (which left the infra + 4 baseline events), now every
endpoint that changes state in server mode persists to the audit log:

### New events

- `auth.logout` — actor + ip + UA. Best-effort resolve of the actor before
  deleting the session, so the event carries who logged out.
- `auth.oidc.success` — actor + `{jit: bool}` (true if it was JIT-provisioned in
  this callback). Includes `orgId`.
- `auth.oidc.denied` — without an actor (or with an actor in the
  account_disabled case). Metadata: `{reason: 'deny_unknown' |
  'pre_provisioned_only' | 'account_disabled', attemptedEmail?: string}`. Covers
  the 3 policy enforcement paths.
- `admin.token.minted` — actor + `resource: token:<id>` + `{name, ttlDays}`.
- `admin.token.revoked` — only if the revoke returned OK (silently skipped when
  the token did not exist).
- `admin.token.revoked_all` — panic button — `{revoked: N}` in metadata.
- `admin.org_token.minted` — actor + orgId + `{name, scopes}`.
- `admin.org_token.revoked` — actor + orgId + resource.

### Endpoint integration test (+9 tests)

`audit-endpoint.integration.test.ts`:
- admin sees the whole org scope.
- member sees only their own events (server-side override of the `actorId`
  query — a member cannot leak with `?actorId=<another>`).
- correct action-prefix filters.
- 400 with a malformed `from`.
- 400 with a non-int `beforeId`.
- 404 when the caller is not a member of the org.
- 404 when `deps.audit` is not wired.
- pagination via beforeId with no overlap between pages.

Totals: **235 unit + 234 int = 469 green**. Typecheck clean.

With this the trail for SOC 2 CC7 is covered end to end: login, logout, SSO (OK
and rejections), auth policy changes, bulk user imports, token minting /
revoking — everything persists the actor + IP + UA + detail.

## [1.0.0-alpha.34] — 2026-06-02

**Audit log (Phase #47)** — an append-only record of security and admin events.

Baseline for compliance (SOC 2 CC7 / ISO 27001 A.12.4): the "who did what, when,
from where" is persisted in an immutable table, queryable from the Admin Console
and the API.

### Schema (migration 0012)

`audit_events`:
- `id bigserial PK` (monotonic, sequenceable).
- `at timestamptz default now()`.
- `org_id uuid` FK organizations ON DELETE SET NULL (keeps the history when the org is deleted).
- `actor_id uuid` FK users ON DELETE SET NULL (idem; null = no verified actor, e.g. failed login).
- `action text` — dotted convention: `auth.login.success`, `admin.users.csv_imported`, etc.
  Free text, not an enum, so we do not need a migration each time we add events.
- `resource`, `ip`, `user_agent` — useful telemetry for investigating suspicious accesses.
- `metadata jsonb default '{}'` — event-specific detail (counts, target email, scope).
- Indexes: `at DESC`, `(org_id, at DESC)`, `actor_id`, `action`. Cover the typical filters.

### Repository

`DrizzleAuditEventsRepository` with `record(input)`, `list(filters)`, `count(filters)`.

- `record` is the only way to write — there is NO update/delete (append-only by design).
- `list` supports composable filters: orgId, actorId, actionPrefix, from, to, beforeId, limit.
- `actionPrefix` escapes `%` and `_` (does not let the caller inject wildcards).
- Cursor-based pagination: order `at DESC, id DESC`, `beforeId` exclusive cursor.
- `list` clamps the limit to [1, 200] (default 50).
- `count` ignores `beforeId` (counts the universe of the filter).

### Endpoints

`GET /api/admin/orgs/:orgId/audit?actorId&action&from&to&beforeId&limit`

- Only members of the org can read.
- Members see ONLY their own events (filter forced on the server, not opt-in).
- Admins/super_admins see the whole org scope.
- Strict validation of dates + ints; 400 with a clear error if there is garbage.
- Returns `{ events, total }`.

### Events recorded in alpha.34

- `auth.login.success` (password login OK) — actor + ip + UA + `{method:'password'}`.
- `auth.login.failed` — no actor, `{attemptedEmail:'…'}` in metadata.
- `admin.auth_policy.changed` — actor + `{from, to}`.
- `admin.users.csv_imported` — actor + `{created, updated, errors, totalRows}`.

Next step (outside this release): cover token mint/revoke, passkey
register/revoke, OIDC callback (success/denied), logout. The infra is already
there; it is just a matter of adding `deps.audit?.record(...)` in each handler.

### UI

`AdminConsole → Audit` is no longer a placeholder. New `AuditTab` with:
- A newest-first table (At / Actor / Action / IP / Detail JSON).
- Filter by action prefix (controlled input, fires fetch on-change).
- A "Showing N of Total" counter.
- A "Load more" button that paginates with the `beforeId` of the last visible
  one. It is NOT rendered if you already see everything (`total === events.length`).
- Loading / empty / error states.

API client: `listAuditEvents(orgId, query)` with query params correctly escaped
via URLSearchParams. The fake API has a demo fixture (3 events).

### Tests (+30 new)

- `packages/db/src/audit-events.integration.test.ts` — 22 repo tests:
  * `record` with all fields / null actor / default metadata / duplicates.
  * `list` filters: orgId, actorId, actionPrefix (includes adversarial `%` and `_`),
    date range, combinations, pagination cursor (beforeId exclusive, sweep of the
    whole dataset with no duplicates), limit clamp.
  * `count` with/without filters, consistency with `list`.
- `apps/web/src/shell/admin/AuditTab.test.tsx` — 8 UI tests:
  * Loading → table / empty state.
  * Filter dispatch.
  * Load more pagination with beforeId.
  * Load more NOT rendered when total === count.
  * Metadata JSON visible in the cell.
  * actorId null → em-dash.
  * Error → role=alert.

Totals: **236 unit + 225 int = 461 green**. Typecheck clean.

## [1.0.0-alpha.33] — 2026-06-02

**Phase 1.5 (HTTPS Caddy) + Phase #45 (wizard inline OIDC/trusted-header).**

Closure of Phase 1.5 with opt-in TLS by default, and big progress on the wizard:
the installer now asks inline (in server mode) about an **HTTPS domain**, **OIDC
SSO**, and a **trusted-header proxy** — the 3 enterprise backends are
configurable without touching the `docker-compose.yml` afterward.

### HTTPS via Caddy sidecar

- `docker-compose.template.yml`: new `caddy` service with `profiles: ["https"]`,
  bound to `:80` + `:443`, persistent volumes `caddy_data` (Let's Encrypt
  certificates) and `caddy_config`. Read-only mount of the `Caddyfile`.
- New placeholder `__DILUXITE_PORTS__`: the installer publishes `5173:5173` to
  the host when there is NO HTTPS, or only `expose: [5173]` when Caddy is
  terminating TLS and proxying over the internal network.
- The template's comment header was cleaned up (the old placeholders in the
  comments broke the multiline sed render — now everything is documented in
  `install.sh`).

### Wizard install.sh — inline prompts (server mode)

After the admin email+password, the wizard now optionally asks:

1. **HTTPS domain** — if you pass `diluxite.yourdomain.com`:
   - Asks for an email for ACME alerts (default = admin email).
   - Generates a `Caddyfile` with `reverse_proxy diluxite:5173`, `encode zstd gzip`,
     and a WebSocket matcher for `/collab`.
   - Brings up compose with `--profile https`.
   - The install's final URL becomes `https://<domain>` with a notice that
     Let's Encrypt may take 10-30s to issue the cert.
2. **OIDC SSO** (y/N) — collects Issuer URL, Client ID, Client Secret, Redirect
   URI (default inferred from the domain). The env vars are injected into the
   compose's `environment:` block with `awk` (AFTER the sed, so secrets with `&`
   or `/` do not break the substitution).
3. **Trusted-header** (y/N) — header name (default
   `Cf-Access-Authenticated-User-Email`). Explicit warning about the trust model.

### Final summary

The end of the install shows the actual state:
```
Authentication backends
  1. Email + password  ✅  Admin: admin@…
  2. OIDC SSO          ✅  Configured against https://…
  3. Identity-Aware Proxy  not configured
```
(or a pointer "add these env vars" when one is unconfigured).

### Coverage

- The compose template render validated with `docker compose config` in both
  paths (HTTPS + plain HTTP) — both produce valid YAML.
- The wizard passes `bash -n` (syntax check).
- Full suite: **228 unit + 203 int = 431 green** (2 timing flakes pass in
  isolation; unrelated to these changes).
- Typecheck clean.

### What's done in Phase 1.5

✅ Security headers (helmet) — alpha.29.
✅ CSRF double-submit — alpha.32 (+23 tests).
✅ HTTPS Caddy default — alpha.33.

### What's done in Phase #45 (wizard)

✅ Post-install SSO hints — alpha.31.
✅ Inline prompts OIDC + trusted-header + HTTPS domain — alpha.33.

Minor pending: move the mode step (local/server) higher up in the wizard flow.
Non-blocking: today it is Step 7, after steps common to both modes.

## [1.0.0-alpha.32] — 2026-06-02

**Phase 1.5 (CSRF part) — CSRF double-submit cookie defense.**

Closes the "No explicit CSRF token" gap documented in `docs/SECURITY.md`.
Defense in depth over `SameSite=Lax` — the browser already blocks most cases,
but some scenarios (specific iframes, subdomain trust, historical browser bugs)
could leak the cookie cross-site. With this release, the server **additionally**
requires the caller to echo a secret token in the `X-CSRF-Token` header.

### Mechanism

When minting a session (`/api/auth/login` with password, OIDC callback, or
passkey-sign-in), the server:
1. Sets `Set-Cookie: diluxite_session=…; HttpOnly; SameSite=Lax`.
2. Sets `Set-Cookie: diluxite_csrf=<random32B>; SameSite=Lax` (**NOT HttpOnly** —
   the SPA has to read it).
3. Returns `{ ok: true, ..., csrf: "<token>" }` in the body so the client does
   not depend on `document.cookie`.

On every cookie-authenticated `POST/PUT/DELETE/PATCH`, a preHandler:
- Skips if the method is `GET/HEAD/OPTIONS` (safe).
- Skips if the request uses `Authorization: Bearer …` (token auth, no CSRF risk).
- Skips if there is NO session cookie (the caller will be rejected by auth with 401).
- If there is a session cookie but the CSRF cookie is missing → 403.
- If the CSRF cookie and the `X-CSRF-Token` header differ (constant-time) → 403.

Logout clears both cookies (`Max-Age=0`).

### Implementation

- `apps/api/src/csrf.ts` (new): `mintCsrfToken()`, `csrfCookieHeader()`,
  `csrfCheck()`, `extractCookie()`. Pure helpers + a `CsrfDecision` type.
- `apps/api/src/app.ts`: global preHandler registered ONLY if
  `DILUXITE_CSRF_DISABLED` is not set. Login/OIDC/passkey endpoints are exempt
  (there is no session yet — mint the first time). The helper
  `setSessionAndCsrf(reply, token, maxAge)` consolidates the 2 cookies + returns
  the CSRF token to include in the body.
- `apps/api/src/passkey-routes.ts`: the same treatment for the passkey sign-in
  flow.
- `apps/web/src/api.ts`: helpers `readCsrfFromCookie()` + `withCsrf()` +
  `csrfHeaders()` + new `DEL()` for DELETE requests. The POST helper also injects
  the header automatically. The 12 sites that used `{ method: 'DELETE' }` now use
  `DEL()`.

### Toggle for tests / dev

`DILUXITE_CSRF_DISABLED=1` disables the preHandler globally. The integration
suite sets it in `apps/api/test/setup-integration.ts` (same pattern as
rate-limit + helmet). The dedicated `csrf.integration.test.ts` unsets it to
exercise the gate.

### Tests (23 new, all green)

`apps/api/src/csrf.integration.test.ts`:
- 9 unit tests of the pure `csrfCheck` helper (safe methods, Bearer, no-session,
  missing cookie, missing header, mismatch, match, length-mismatch,
  case-insensitivity, all state-changing methods).
- 5 on `csrfCookieHeader`/`clearCsrfCookieHeader`/`extractCookie` (NOT HttpOnly,
  Max-Age=0 on clear, multi-value parsing, `=` in value, minter entropy).
- 7 E2E via buildApp (POST without CSRF → 403, POST with CSRF → 401 auth, GET
  exempt, Bearer exempt, login exempt, no cookies → 401, header without cookie →
  403).
- 1 on the disabled toggle.
- 1 reserved for the full flow (covered manually).

Suite totals: **228 unit + 203 int = 431 tests, all green**. Typecheck clean in
4 packages.

### Notes

- The SPA client now sends `X-CSRF-Token` automatically on all mutations — it
  requires no changes in individual components.
- In local mode (single-user, no auth) the cookie is never minted, so
  `readCsrfFromCookie()` returns null and the header is absent — there is no
  preHandler either, because local mode uses `SingleUserAuthProvider`.

Next step in Phase 1.5: HTTPS by default via a Caddy sidecar in the compose
template + a `--with-domain` flag in the installer to issue Let's Encrypt.

## [1.0.0-alpha.31] — 2026-06-02

**Wizard `install.sh` — post-install SSO hints in server mode** (Phase #45, step 1).

When the operator chooses `2) Server` in the wizard, the final summary now
includes an **Enterprise SSO (optional)** block that explains the three auth
backends available beyond the admin-bootstrap email+password:

1. **Email + password** (already configured by the wizard).
2. **OIDC SSO** (Okta / Entra / Google / Authentik / Auth0). Shows the exact 4
   env vars to add to the install path's `docker-compose.yml`
   (`DILUXITE_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI`)
   and clarifies that after `docker compose up -d` the **"Sign in with SSO"**
   button appears on the login screen.
3. **Identity-Aware Proxy** (Cloudflare Access / Authelia / Pomerium):
   `DILUXITE_TRUSTED_IDENTITY_HEADER` + an explicit warning about the trust
   model — ALL traffic must go through the proxy or the header can be forged.

It also clarifies how to load the initial user list via **CSV bulk-import**
(Admin Console → Users → "Import CSV") and where the **default auth policy** is
(`allow_unknown_as_member`, configurable in Settings → Auth).

The block does NOT appear in `local` mode (it does not apply — local mode
bypasses auth).

Next pending steps in Phase #45 (not in this release): move the mode prompt to
the top of the wizard, and add optional inline prompts for OIDC and
trusted-header instead of post-install instructions.

## [1.0.0-alpha.30] — 2026-06-02

**Phase 1.3 — Settings UI for auth policy** + REST endpoints.

### Endpoints

`GET  /api/admin/orgs/:orgId/auth-policy` → `{ policy }`
- Members + admins can read (UX: see the current value).
- 404 when OIDC is not enabled on the server (the policy does not apply).
- 403 when the caller is not a member of the org.

`PUT  /api/admin/orgs/:orgId/auth-policy` with body `{ policy }`
- Only admin/super_admin can change it.
- 400 with an unknown policy (whitelist enforced).
- Idempotent (writing the same value 3x → OK).
- 403 for member roles.
- 404 when OIDC is not configured.

### UI

`apps/web/src/shell/admin/AuthPolicyTab.tsx`:
- Loads the current policy on mount.
- 3 radio buttons with a title + human-readable description.
- The restrictive options (`deny_unknown`, `pre_provisioned_only`) show a yellow
  "import the user CSV first" warning so the admin does not lock themselves out.
- Selection triggers an immediate save (no separate Save button).
- Confirmation message visible after a successful save.
- Friendly loading + error states.

### Client API

`api.ts` adds `getAuthPolicy(orgId)` + `setAuthPolicy(orgId, policy)` + an
`AuthPolicyValue` type. `fakeApi` implements them with in-memory state.

### Tests (+20)

**11 integration** (`auth-policy-api.integration.test.ts`):
- GET default (allow_unknown_as_member) when there is no row.
- GET persisted after PUT.
- GET 403 for a non-member.
- PUT admin with the 3 valid values.
- PUT idempotent (3x same value).
- PUT 400 with unknown policy / missing field.
- PUT 403 for member role.
- GET/PUT 404 when deps.oidc is not wired.

**9 UI** (`AuthPolicyTab.test.tsx`):
- Loading → 3 options, current marked.
- Click another → calls setAuthPolicy with the value.
- Confirmation visible post-save.
- Newly-selected stays checked.
- Errors: getAuthPolicy throw → alert; OIDC null → friendly message;
  setAuthPolicy throws → alert + previous is kept.
- UX: restrictive options have a warning, the default does not.

Total: 417/417 green, 0 regressions.

### Pending for Phase 1.5

- HTTPS by default (Caddy sidecar) — alpha.31+.
- Explicit CSRF token — alpha.31+.
- Improve the install.sh wizard.

## [1.0.0-alpha.29] — 2026-06-02

**Phase 1.5 part 1 — Security headers via `@fastify/helmet`**.

`apps/api/src/app.ts` registers Helmet with a conservative config:

- **CSP**: `default-src 'self'`, strict script-src (no unsafe-inline →
  XSS-resistant), style-src 'self' + 'unsafe-inline' (Vite generates CSS with
  inline tags for critical-CSS), connect-src `'self' ws: wss:`, img-src `'self'
  data: blob:`, **frame-ancestors `'none'`** (anti-clickjacking).
- **HSTS** 1 year + includeSubDomains.
- **X-Content-Type-Options**: nosniff.
- **Referrer-Policy**: strict-origin-when-cross-origin.
- **Cross-Origin-Opener-Policy** + **Cross-Origin-Resource-Policy**:
  same-origin.

Opt-out via `DILUXITE_HELMET_DISABLED=1` (the global integration suite sets it
by default so as not to inflate the tests with headers).

### Tests (+7)

`apps/api/src/security-headers.integration.test.ts`:

- CSP present + default-src 'self' + script-src without unsafe-inline +
  frame-ancestors 'none'.
- HSTS max-age >= 1 year + includeSubDomains.
- X-Content-Type-Options: nosniff.
- Referrer-Policy: strict-origin-when-cross-origin.
- COOP: same-origin.
- CORP: same-origin.
- Opt-out flag: with DILUXITE_HELMET_DISABLED=1 NO headers are added.

Total: 397/397 green.

### Pending for Phase 1.5

- **HTTPS by default** (Caddy sidecar in docker-compose.template + an install.sh
  domain prompt) — next alpha.
- **CSRF token** (double-submit cookie pattern) — next alpha.

## [1.0.0-alpha.28] — 2026-06-02

**Phase 1.4 — TrustedHeaderAuthProvider** (port of the Diluxclaw pattern).

Lets you put Diluxite behind an Identity-Aware Proxy (Cloudflare Access,
Authelia, Pomerium, oauth2-proxy, traefik-forward-auth) that authenticates the
user upstream and passes us the identity in a network-signed header.

### Changes

`packages/core/src/auth.ts`:
- New interface `UsersRepoForTrustedHeader` (minimal contract without coupling
  us to `@diluxite/db`).
- `AuthPolicy` type exported for reuse in other providers.
- `TrustedHeaderAuthProvider` with a resolve() that covers all branches:
  - Header missing/empty/array-empty → null (delegates).
  - Email malformed → null.
  - User existing + active → touchLastLogin + identity.
  - User existing + active=false → null (the gate closes the API to 401).
  - User unknown + policy `allow_unknown_as_member` → JIT create with
    provider='trusted_header'.
  - User unknown + policy `deny_unknown` / `pre_provisioned_only` → null.

`apps/api/src/services.ts`: optionally activates the provider at boot if
`DILUXITE_TRUSTED_IDENTITY_HEADER` is set. Chains it with the
SessionAuthProvider: if the cookie/Bearer session does NOT resolve, the header
acts as a fallback. If both resolve (rare case), the explicit session wins.

### Trust model documented

Anyone who can reach the API port WITHOUT going through the proxy can spoof the
header and impersonate users. It is the **operator's responsibility** to ensure
the network path forces all requests through the proxy (private listener /
firewall). The provider and the docs say this explicitly.

### Tests (+23 furious)

**14 unit** (`packages/core/src/trusted-header-auth.test.ts`):
- Header presence: missing, empty string, empty array, multi-value (takes the
  first).
- Email shape: malformed → null, lowercase + trim, multi-value.
- Existing user: active → identity + touchLastLogin; soft-disabled → null + NO
  touch.
- JIT under policy: allow_unknown → JIT create+touch; deny_unknown → null with
  no create/touch; pre_provisioned_only unknown → null; pre_provisioned_only
  with a user pre-loaded via CSV → identity.
- Config: custom header name, does NOT honor the Cloudflare default if
  configured differently.

**9 integration** (`apps/api/src/trusted-header.integration.test.ts`):
- End-to-end Fastify + real DB:
  - Header with a valid email + JIT → GET /api/spaces returns 200.
  - Existing csv_import user → the header resolves it without overwriting the
    provider.
  - last_login_at is updated on every request.
  - No header → 401.
  - Header malformed → 401.
  - User active=false → 401.
  - Policy deny_unknown + unknown email → 401, user NOT created.
  - Policy pre_provisioned_only + unknown email → 401.
  - Custom header name → respects only THAT header (not the default).

Total: 390/390 green, 0 regressions.

### Pending from the backlog

- Phase 1.3: UI Settings → Auth tab to change the policy from admin (left as a
  separate task — the set-policy endpoint too).
- Phase 1.5: HTTPS default + security headers + CSRF.
- Improved install wizard.

## [1.0.0-alpha.27] — 2026-06-01

**Phase 1.2 — Bulk CSV import of users**. Endpoint + UI + parser + 44 tests
following the furious-tests policy.

### Parser (`packages/core/src/csv-users.ts`)

`parseUsersCsv(text)` — no external dep, AGPL-friendly:
- Auto-detects the separator (`,` or `;` — Excel es locale).
- RFC 4180 quotes with `""` escape.
- UTF-8 BOM stripped.
- CRLF and LF.
- Case-insensitive headers with synonyms (e-mail, correo, nombre, apellido,
  rol, given_name, family_name, etc.).
- Only `email` is required.
- Roles validated against the enum (admin/super_admin/member/editor/viewer).
- Per-row errors with a 1-based line number + raw text for the UI report.
- Detects intra-CSV duplicates.

### API endpoint

`POST /api/admin/orgs/:orgId/users/import-csv`
  - Body: `{ csv: string, dryRun?: boolean }`
  - Allows ONLY admin/super_admin of the org → 403 for the rest.
  - Validates the body shape → 400.
  - 413 if > 2 MB.
  - Dry-run: parse + return preview, no DB writes.
  - Apply: upsert by email via `users.upsertFromCsv`, returns created/updated
    counts.
  - Per-row parse errors do NOT abort the batch — good rows are applied.

### UI (`apps/web/src/shell/admin/UsersImportCsv.tsx`)

Standalone reusable component:
- Drag-drop zone + file picker + textarea (3 ways to load the CSV).
- Preview button → shows a table with the first 100 rows + an expandable error
  block.
- Apply visible only after a successful Preview with ≥1 row.
- Result with created/updated counts + an `onImported` callback so the parent
  refreshes the user list.
- The detected separator is shown to the user.

### Tests (+44)

**24 parser unit tests** (`csv-users.test.ts`):
- Happy paths: comma + semicolon, synonyms, mixed-case headers, only-email,
  quoted-with-separator-inside, doubled-quote escape, BOM, CRLF, blank lines,
  unknown columns tolerated.
- Errors: missing email header, empty CSV, malformed email, empty email,
  invalid role, duplicate emails, line numbers correct.
- Adversarial: header-only, 1000 rows, whitespace trimming, embedded semicolons
  in quoted fields, separator reported back.

**10 endpoint integration tests** (`csv-import.integration.test.ts`):
- Dry-run does not write.
- Apply creates + reports counts.
- Re-running is idempotent (0 created, N updated).
- Per-row errors do not abort the batch.
- 400 without csv / with non-string.
- 413 with > 2 MB.
- 403 when the caller is not an admin.
- Line numbers 1-based.
- Preserves the existing provider (CSV does not overwrite 'oidc' → 'csv_import').

**10 UI tests** (`UsersImportCsv.test.tsx`):
- Initial render (dropzone + textarea, no preview).
- Paste → Preview → table with rows.
- Apply → counts + invokes onImported.
- Errors: malformed emails show the block, missing header hides Apply.
- Guards: Apply hidden when rows=0, CSV preserved between Preview/Apply.
- Adversarial: separator visible in the preview, cap of 100 rows with "+N more".

### Client API

`apps/web/src/api.ts` gains `importUsersCsv(orgId, csv, { dryRun? })` + an
exported `CsvImportResult`. `fakeApi.ts` uses the real parser from
`@diluxite/core` (a new workspace dep) for fidelity.

Total: 367/367 green, +44 tests, 0 regressions.

## [1.0.0-alpha.26] — 2026-06-01

**Super exhaustive tests of the end-to-end OIDC flow.** Covers the gaps that
were left in alpha.25 ("validated with a real smoke test" — Pablo, rightly,
asked NOT to rely on that).

New policy in `docs/PATTERNS.md` (§9 extension): every feature brings unit +
integration + adversarial. Zero "later".

### Real mock OIDC issuer (`apps/api/test/oidc-mock-issuer.ts`)

In-process Fastify that signs id_tokens with `jose` and real RSA:
- `GET /.well-known/openid-configuration` — discovery
- `GET /jwks.json` — public JWKS with the good key
- `GET /authorize` — 302 to redirect_uri with a code or error per config
- `POST /token` — validates PKCE (S256), generates a signed RS256 id_token
- Per-test config: claims, forgedIssuer, tokenError, authorizeError,
  signWithBadKey.

It does NOT mock openid-client — the lib uses the real endpoint for discovery,
JWKS fetch, and claim validation. If the upstream lib changes, the test fails.

### E2E tests (`apps/api/src/oidc-e2e.integration.test.ts`) — +18

**Happy paths (4)**:
- JIT creates a brand-new user with claims, sets an HttpOnly+SameSite cookie.
- Existing user does not re-create (same id on login #2).
- `last_login_at` is updated on every login (measures >30ms drift).
- Lowercases the email claim before matching.

**auth_policy enforcement (4)**:
- `deny_unknown` → 403, user NOT created.
- `pre_provisioned_only` → 403 with a friendly "talk to admin" message.
- `pre_provisioned_only` + a user pre-loaded via CSV → enters OK, provider stays
  'csv_import' (not overwritten to 'oidc').
- `allow_unknown_as_member` (default) → JIT 302.

**Soft-disable (1)**:
- `active=false` → the IdP authenticates but Diluxite responds 403 "your admin
  disabled this account". Verified with two separate logins: first successful,
  then admin disables, second attempt rejected.

**Adversarial (7)**:
- Callback with an unknown state → 400 "unknown or expired".
- Callback without the state param → 400 "missing state".
- IdP returns error=access_denied → 400.
- `id_token` with a forged `iss` (does not match discovery) → 400.
- `id_token` without the email claim → 400.
- `id_token` with a non-string email → 400.
- `id_token` with an email without `@` → 400.

**Token endpoint errors (1)**:
- Token endpoint returns `invalid_grant` → 400.

**Single-use ceremony (1)**:
- Replay of the callback URL → first 302, second 400 (DELETE-RETURNING makes the
  ceremony single-use).

### Other changes

- `oidc.ts`: `buildOidcClient` accepts `DILUXITE_OIDC_ALLOW_INSECURE=1` to allow
  `http://localhost` in tests/dev (default OFF in prod).
- `test/helpers.ts`: `buildTestApp` now also returns `defaultOrgId` and `userId`
  (needed for the OIDC tests).

Total: 323/323 green, +18 exhaustive OIDC E2E.

## [1.0.0-alpha.25] — 2026-06-01

**Phase 1.1 — OIDC SSO** functional (Entra/Okta/Google/Authentik/Auth0).

### Plumbing

- `openid-client@6` + `jose@6` added to `apps/api`.
- `apps/api/src/oidc.ts` — helpers `readOidcConfig`, `buildOidcClient`,
  `buildAuthorizeUrl` (state + nonce + PKCE S256), `handleCallback`
  (validate + extract claims).
- Migration `0011`: `oidc_ceremonies` table (state PK, nonce, code_verifier
  secret, expires_at TTL 10 min).
- `DrizzleOidcCeremoniesRepository` with save / consume (atomic delete+return →
  single-use replay safety) / sweepExpired.
- `AppDeps.oidc?` optional with config + client + ceremonies + orgSettings + orgId.
- `services.ts` discovers the IdP at boot if the env vars are complete
  (`DILUXITE_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`).
- `Info.oidcEnabled` flag so the frontend knows whether to show "Sign in with SSO".

### Endpoints

`GET /api/auth/oidc/login` (rate-limited 10/min/IP):
  - generates state + nonce + PKCE verifier
  - persists the ceremony
  - 302 to the IdP authorize endpoint

`GET /api/auth/oidc/callback` (rate-limited 10/min/IP):
  - consumes the ceremony (single-use)
  - exchanges the code for an id_token (with PKCE) and validates vs JWKS
  - extracts email/given_name/family_name from the id_token
  - **JIT + policy enforcement** per `org_settings.auth_policy`:
    - `deny_unknown` → 403
    - `pre_provisioned_only` → 403 with a "talk to admin" message
    - `allow_unknown_as_member` → creates the user with provider='oidc'
  - checks `users.active` (the admin may have disabled it)
  - `touchLastLogin`
  - **mints a LOCAL session cookie** (the JWT is not passed to the browser)
  - 302 to `/`

### Frontend

- `LoginScreen.tsx`: fetches `/api/info` on mount, reads `oidcEnabled`. If true,
  shows a "Sign in with SSO" button below the passkey. Click → full-page
  redirect to `/api/auth/oidc/login` (needs to leave the SPA so the IdP does its
  flow with its cookies).
- `Info` interface gains `oidcEnabled?: boolean`.

### Tests

- `apps/api/src/oidc.integration.test.ts` (+6):
  - save+consume roundtrip of state/nonce/codeVerifier
  - consume single-use (replay refuses)
  - unknown state → null
  - expired ceremony → null (does not return one whose expires is in the past)
  - sweepExpired only deletes expired ones, returns count
  - org_settings defaults to allow_unknown_as_member if there is no row

Total: 305/305 green.

### How an admin who has Okta/Entra tests it

1. Brings up Diluxite in `server` mode.
2. In their IdP they create an OIDC-type "Application" with redirect URI
   `https://diluxite.acme.com/api/auth/oidc/callback`.
3. Sets env vars in their compose:
   ```
   DILUXITE_AUTH_MODE=server
   DILUXITE_OIDC_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0
   DILUXITE_OIDC_CLIENT_ID=...
   DILUXITE_OIDC_CLIENT_SECRET=...
   DILUXITE_OIDC_REDIRECT_URI=https://diluxite.acme.com/api/auth/oidc/callback
   ```
4. `docker compose up -d`. The login screen shows "Sign in with SSO".
5. Click → IdP authenticates + MFA → callback → JIT creates the user in Diluxite
   (if `allow_unknown_as_member`) or rejects it (other policies).

### Next steps (alpha.26+)

- CSV import endpoint + UI (Phase 1.2)
- Settings → Auth tab to change the policy from the UI (Phase 1.3)
- TrustedHeaderAuthProvider (Phase 1.4)
- HTTPS + headers + CSRF (Phase 1.5)
- Improved install wizard

## [1.0.0-alpha.24] — 2026-06-01

**Phase 1.0 — Foundation of enterprise-ready auth**. Schema + repos to be able
to plug in OIDC (Okta/Entra/Google/Authentik), CSV user import, soft-disable,
and configurable admission policies.

### Schema changes (migration 0010)

`users` gains:
- `first_name`, `last_name` (text, nullable). Populated by CSV import or by OIDC
  id_token claims.
- `active` (boolean default true). Soft-disable preserving history — preferred
  over DELETE because it keeps note authorship.
- `last_login_at` (timestamp nullable). Cheap telemetry for "users who have not
  logged in for 90 days" reports → deprovision.
- 2 indexes for common queries (`active=false`, `last_login_at`).

`org_settings` new table:
- `org_id` (PK, FK organizations).
- `auth_policy` (text default 'allow_unknown_as_member'). Three valid values
  enforced by a CHECK constraint:
    - `deny_unknown`: rejects with 403 anyone who passes SSO but is not in users.
    - `allow_unknown_as_member`: JIT-creates with a minimal role (default).
    - `pre_provisioned_only`: rejects with a friendly "talk to your admin"
      message.

### Types / repos

- `User` interface (in `spaces-repository.ts`) extended with the 4 new fields.
- `DrizzleUsersRepository` adds:
    - `setActive(userId, active)` — soft-disable.
    - `touchLastLogin(userId)` — called by `AuthProvider.resolve()` on every
      successful login.
    - `createFromExternal({ email, firstName, lastName, provider })` — JIT entry
      point (provider = 'oidc' | 'trusted_header' | …).
    - `upsertFromCsv({ email, firstName?, lastName? })` — idempotent, preserves
      existing fields when the CSV passes them null. Returns
      `{ user, outcome: 'created' | 'updated' }` to report counts in the UI.
- `DrizzleOrgSettingsRepository` new, with `getAuthPolicy(orgId)` (falls back to
  the default if the row does not exist) + `setAuthPolicy(orgId, policy)`
  (upsert with `ON CONFLICT DO UPDATE`).

### Tests

- `org-settings.integration.test.ts` (+6): sparse default, roundtrip of each
  policy, idempotence, overwrite, CHECK constraint at the DB level.
- `users-enterprise.integration.test.ts` (+8): createFromExternal lowercases
  email + sets active=true; setActive round-trip; touchLastLogin with a
  timestamp +/- 2s clock skew; upsertFromCsv create vs update, null fields not
  overwritten, idempotent across 3 runs.

Total: 299/299 green. +14 Phase 1.0 tests.

### NOT included (upcoming alphas)

- alpha.25: `OidcAuthProvider` + login UI with "Sign in with SSO".
- alpha.26: CSV import endpoint + UI with drag-drop.
- alpha.27: Settings → Auth tab (policy dropdown).
- alpha.28: `TrustedHeaderAuthProvider` (Diluxclaw's Cloudflare Access pattern).
- alpha.29: HTTPS default + security headers + CSRF.
- alpha.30: Improved install wizard (local vs server mode at the start).

### Important clarification

All of this **only applies to `server` mode**. Local mode (Pablo alone on his
PC, the installer default) keeps working with SingleUserAuthProvider, no login,
ignoring `auth_policy` entirely.

## [1.0.0-alpha.23] — 2026-06-01

**The Settings → MCP UI** that was missing to close hardening #2.

### Changes in `SettingsModal → McpTab`

- New optional **"Expires in (days)"** input next to the token name one. Empty =
  no TTL (legacy). Positive number = applied.
- Each token in the list now shows its bottom line: `expires: never` |
  `expires: 12/15/2026` | `expires: expired`.
- A danger **"Revoke all (N)"** button next to the list header, visible only
  when there is ≥1 token. It opens a `dialogs.confirm` with clear text about the
  consequences and, on accept, calls `api.revokeAllTokens()` and reloads the
  list.
- Cancelling the confirm preserves the tokens (explicit test).

### Tests (`apps/web/src/layout/McpTab.test.tsx`)

6 new:

- TTL input visible next to the name.
- Mint without TTL → "expires: never".
- Mint with TTL=30 → a concrete date (neither "never" nor "expired").
- Revoke-all hidden with 0 tokens, visible with ≥1.
- Click + accept the confirm empties the list.
- Click + cancel preserves.

Total: 285/285 green, 0 regressions.

### Hardening status

- ✅ #1 Rate limit auth endpoints (alpha.21)
- ✅ #2 Token TTL + revoke-all (alpha.22 backend + alpha.23 UI)
- ⏳ HTTPS by default (next)
- ⏳ Explicit CSRF token
- ⏳ Audit log
- ⏳ 2FA TOTP
- ⏳ Invalidate sessions on password change (gated: requires an endpoint)

## [1.0.0-alpha.22] — 2026-06-01

Hardening #2: **Token TTL + revoke-all** (panic button). Item #2 of the plan in
`docs/SECURITY.md §9`.

### Changes

- Migration `0009_tokens_expires_at.sql`: new `expires_at` column NULL by
  default (preserves existing "no expiration" tokens) + a partial index over
  non-null tokens for fast sweeps.
- `packages/db/src/schema.ts`: `tokens.expiresAt` added to the schema.
- `DrizzleTokensRepository.create(userId, name, expiresInDays?)`: the optional
  third arg sets the TTL. `null` or absent → no expiration (backwards-compat
  with the legacy `mintToken`).
- `findUserIdByToken` and `resolveToken` now filter `expires_at IS NULL OR
  expires_at > NOW()`. Expired tokens silently stop authenticating — the client
  gets the standard 401 as if the token did not exist.
- `DrizzleTokensRepository.revokeAllForUser(userId)`: panic button — deletes ALL
  of the user's tokens, returns the count.
- New endpoint `POST /api/tokens/revoke-all` → `{ revoked: N }`.
- `POST /api/tokens` accepts an optional `expiresInDays` in the body.
- `TokenInfo` (api.ts) gains an `expiresAt: string | null` field.
- API client (`api.ts` + `fakeApi.ts`) updated: `mintToken(name,
  expiresInDays?)` + `revokeAllTokens()`.

### Tests (`apps/api/src/tokens-api.integration.test.ts`)

- `mints with TTL — expired tokens stop authenticating`: mints with
  `expiresInDays: 7`, forces expiry to the past via SQL, verifies the
  StoredTokenAuthProvider rejects it.
- `mintToken without expiresInDays returns expiresAt: null (legacy behaviour)`:
  explicit backwards-compat.
- `POST /api/tokens/revoke-all wipes every token for the caller`: mints 3,
  panic-revokes, verifies the endpoint returns `revoked: 3` and the list is
  empty.

Total: 279/279 green.

### Frontend NOT included yet

The UI for the panic button + TTL chooser in Settings → MCP is left for
alpha.23. For now it is accessed via curl/MCP client.

### Pending from the hardening plan (recommended order)

- HTTPS by default in the installer (Caddy sidecar) — ~3h, requires changes to
  the installer and the compose template.
- Explicit CSRF token (double-submit) — ~2h.
- Audit log table + endpoints — ~3h.
- 2FA TOTP — ~4h.
- Invalidate sessions on password change — ~1h (gated: requires a
  change-password endpoint that does not exist yet).

## [1.0.0-alpha.21] — 2026-06-01

Hardening #1 of the security plan: **rate limiting** on the auth endpoints.
Covers the first gap at the top of the backlog in `docs/SECURITY.md §9`.

### Changes

- `apps/api/src/app.ts`: registers `@fastify/rate-limit` with `global: false`
  (opt-in per route). `buildApp()` becomes async because the `app.register` must
  complete BEFORE the routes are declared with `config.rateLimit`.
- `POST /api/auth/login`: 5 attempts/min/IP. 6th request → 429 with
  `Retry-After`.
- `POST /api/auth/passkey/authenticate-options` and `…/authenticate-verify`:
  10/min/IP each (more lax because the WebAuthn flow asks for both in quick
  succession).
- Rate-limit identity: `x-forwarded-for` (first IP) or `req.ip` — works behind a
  real proxy with `trustProxy` configured, and directly when self-hosted.
- Opt-out: `DILUXITE_RATE_LIMIT_DISABLED=1` skips the entire register. The
  global integration test setup enables it by default so the flood scenarios
  keep working; the dedicated test disables it per-test.

### Tests (`apps/api/src/rate-limit.integration.test.ts`)

- `returns 429 after exceeding the per-IP login budget`: 6 consecutive requests
  to the endpoint from the same IP → the first 5 work (404 because
  authMode=local), the 6th is 429.
- `429 response includes a Retry-After header`: the client can back off with a
  clear value.
- `does NOT rate-limit /health (10 hits in a row, all 200)`: regression proof
  that the plugin stays `global: false`. If someone changes it to `global: true`
  by mistake, monitoring would break silently — this test prevents it.

### Migration for buildApp callers

`buildApp(deps)` now returns `Promise<FastifyInstance>`. Updated sites in this
commit:
  - `apps/api/src/index.ts`
  - `apps/api/test/helpers.ts`
  - 5 integration test files

Total: 276/276 green.

### Pending from the hardening plan

Next in the queue (alpha.22+):
- Token TTL + revoke-all UI
- HTTPS by default in the installer (Caddy sidecar)
- Explicit CSRF token
- Audit log table
- 2FA TOTP
- Invalidate sessions on password change

## [1.0.0-alpha.20] — 2026-06-01

Four deliverables in one release: tests policy, security doc, enriched command
palette, large lists with filter + cap. All with mandatory tests following the
new policy.

### docs/PATTERNS.md §9 — "Tests for everything" (written policy)

Every PR that touches runtime requires tests at the appropriate level (unit /
integration / component / e2e). A table by change type, explicit anti-patterns,
a mandatory regression-test rule for user-reported bugs. Lists the three live
regression tests (collab WS sync, TreeRow display-none, ActivityBar
single-settings).

### docs/SECURITY.md — new, complete security model

- Auth modes: `local` (SingleUserAuthProvider) vs `server` (SessionAuthProvider
  with HttpOnly+SameSite cookies + Bearer fallback).
- Four layers (identity → middleware → per-workspace ACL → Postgres RLS).
- Org tokens with scopes (read/write/admin) + CHECK XOR.
- MCP uses the same `AuthProvider` with Bearer.
- What it DOES protect (8 items) + honest gaps (9 items with severity and
  priority).
- A 7-step hardening plan (rate limit, token TTL, HTTPS default, CSRF, audit
  log, 2FA, invalidation on password change) with estimates.
- Diagram of the request flow → identity → ACL → RLS.

### Enriched command palette (`apps/web/src/shell/TopBar.tsx`)

`>` now shows:

  - New note (default, already there)
  - **New folder** (if the parent passes `onNewFolder`)
  - **New workspace** (if the parent passes `onNewWorkspace`)
  - Open graph (already there)
  - **Connect AI (MCP)** — deep-link to `/settings/connect`
  - **Create API key (MCP)** — deep-link to `/settings/mcp`
  - **Open Admin** — gated: only appears if the user has an admin / super_admin
    role in some org (computed in `App.tsx` with `orgs.some(...)`)
  - Settings (already there)

Five new entries, all optional so as not to break existing consumers of the
component.

### Large lists — filter + cap + overflow hint

So `WorkspaceSelector` and `OrgIndicator` can withstand an "endless list":

- **Filter input** that appears when the list exceeds `FILTER_THRESHOLD = 12`.
  Auto-focus on open. Case-insensitive search by name. Resets when the dropdown
  closes.
- **Render cap** of `RENDER_CAP = 200` items visible at a time. Extra items are
  reported with a `+N more — refine the filter` hint (not loaded into the DOM).
- Differentiated empty-state messages: "No workspaces yet" (globally empty list)
  vs "No matches" (non-empty list, empty filter).

This is NOT full virtualization (it does not use react-virtuoso). The fixed cap
is enough for the alpha range (≤ 200 visibly rendered items); if in real use a
user has 500+ workspaces, swap it out behind the same API.

### New tests (the tests-for-everything policy in action)

- `WorkspaceSelector.test.tsx`: 7 tests covering the small-list (trigger, no
  filter input, pick), large-list (filter visible at the threshold,
  case-insensitive filter, **N=1000 with cap + overflow hint**, filter survives
  N=1000), and a performance bound (mount < 1s against 1000 items).
- `TopBar.test.tsx`: 2 new tests for the conditional command palette items
  (folder/workspace/admin) + negative case (Open Admin hidden if there is no
  role).
- `App.test.tsx`: updated the account-popover test to the new flow (single
  "Settings" button → `/settings`, not `/settings/appearance`).

Total: 273/273 green (+13 tests).

## [1.0.0-alpha.19] — 2026-06-01

**Avatar popover cleanup** (part 1 of the Settings feedback).

Pablo: "the settings menu still feels weird, it's kind of inaccessible — I can
only reach it from a few options in the user menu, but inside it I'm not sure
whether there are duplicate options".

### Root cause

The avatar popover (bottom-left corner of the ActivityBar) showed **six nearly
identical entries with the same ⚙ icon**, one per modal tab:

  Connect AI (MCP)
  Appearance
  Search preferences
  MCP connection
  Passkeys
  About

When the modal opens, it shows the same six names as tabs in its inner sidebar →
a "duplicate" feeling. Also, there was no generic "Settings" button to open the
modal without pre-selecting a tab.

### Fix

`apps/web/src/shell/ActivityBar.tsx`: replace the 6 entries with **a single
"Settings" button** that calls `onSettings()` (no tab arg). The deep-links to
specific tabs are still alive in contexts where they make sense (WelcomePanel
with "Connect AI…" and "MCP connection", TopBar links, etc.) — no functionality
is lost, the popover is just de-cluttered.

### Tests

`apps/web/src/shell/ActivityBar.test.tsx`:

  - Verifies that `account-menu` contains exactly 1 element with the text
    "Settings" (not 6).
  - Negative assertion: the old labels (Connect AI, Search preferences, MCP
    connection, Passkeys, About) must NOT appear in the popover. If a future
    refactor reintroduces them, the test fails.
  - Click on the button calls `onSettings()` (not `onAccount(...)`) — opens the
    modal without pre-selecting a tab.

### NOT included (for the following alphas)

The modal's internal reorganization (Connect AI / Search / AI embeddings as an
"Instance" section instead of mixed in with personal preferences) is left for
alpha.20. I need the `19-28-55.png` screenshot that did not reach the shared
directory to understand exactly which section is being seen as "weird".

## [1.0.0-alpha.18] — 2026-06-01

**Fix of the Explorer sidebar truncating text prematurely on resize** (reported
in real use).

### Root cause

In `TreeRow.tsx`, the "actions" (the icons to the right of each row — "+ new note
here", "rename", "delete") were marked with `opacity-0
group-hover:opacity-100`. **Invisible to the eye, but still taking up horizontal
width**. That steals space from the label's `<button class="flex-1 truncate">` →
the label truncates prematurely with `…` even though the sidebar still has space
to spare.

It is the classic "CSS says opacity 0 but the layout counts them as if they were
there" pattern. Hover → they reappear → the label shrinks further.

### Fix

`hidden group-hover:flex` instead of `opacity-0 group-hover:opacity-100`. The
actions disappear from the layout when not visible (`display: none` → zero
width), and return to `flex` on hover. The label takes up all available width
until it really does not fit.

### Regression test

`apps/web/src/components/TreeRow.test.tsx` with two assertions:

- The actions have `hidden group-hover:flex` and NOT `opacity-0` — if someone
  reverts to the old pattern the test fails.
- The label keeps `flex-1 min-w-0 truncate` (the other half of making the
  truncate work well inside the flex container).

New policy: any user-reported visual fix brings a mandatory regression test.
Documented as part of the "tests for everything" backlog item (task #34).

## [1.0.0-alpha.17] — 2026-06-01

Hotfix of three things pending from alpha.16, all detected by workflows that
were red on main:

### Fix of the 500 on note creation (chunks dimension mismatch)

Reported symptom: `POST /api/spaces/:id/notes` returned **500 Internal Server
Error** with `Failed query: insert into "chunks" ...` and a giant dump of
embedding values. Root cause: the original schema fixed `chunks.embedding
vector(1536)` (the dim of Azure text-embedding-3-large), but the default Ollama
embedder (mxbai-embed-large) returns 1024 dims. Any installation that starts
with Ollama from the outset or switches from Azure to Ollama breaks the INSERT
with "expected 1536 dimensions, not 1024".

The earlier notes from the initial seed (3000+) have 1536-dim vectors and
worked. The bug only appeared when creating a new note with the active embedder
different from the one that generated the seed.

Fix (migration `0008_chunks_vector_any_dim.sql`):

  ALTER TABLE chunks ALTER COLUMN embedding TYPE vector USING embedding::vector;
  DROP INDEX IF EXISTS chunks_embedding_idx;

`vector` without a fixed dimension lets pgvector accept embeddings of any dim.
It keeps the old 1536 from the seed and the new 1024 from Ollama. The price:
dropping the HNSW index (which requires a known dim at CREATE INDEX). For alpha
volumes (≤100k chunks) the sequential search runs in <100ms, acceptable.

The Drizzle schema (`packages/db/src/schema.ts`) now uses a `customType`
`vectorAnyDim` that encodes as `[v1,v2,…]` and decodes as `number[]`, with no
dim constraint.

### Typecheck green (4 Node versions × 4 projects)

- `apps/web/src/components/CodeMirrorEditor.tsx`: the `.map().filter(...)`
  inferred `(PresenceUser | null)[]` and the filter's type predicate was not
  validated. Rewritten as a `for…of` with `users.push(...)` — same result,
  type-safe without a trick.
- `apps/web/test/render-with-ctx.tsx`: the test helper did not include the
  `user` and `collabUrl` fields that `AppCtx` added in alpha.11 / .15. Added both
  with `null` defaults.

### Lint green (eslint --max-warnings=0)

- `apps/web/src/components/CodeMirrorEditor.tsx`: I removed an
  `eslint-disable-next-line react-hooks/exhaustive-deps` that pointed at a rule
  NOT configured in this repo. ESLint with `--max-warnings=0` treats "rule not
  found" as an error. Replaced with a human comment explaining why the deps are
  minimal (the callbacks live in refs).

### No functional changes in the existing code

- Collab keeps working the same (Hocuspocus 2.x).
- 260/260 tests green, no regressions.
- The smoke gate stays active and verifying.

## [1.0.0-alpha.16] — 2026-06-01

**Base image security patch** — the `docker-scan.yml` workflow failed against
alpha.15 due to **CVE-2026-6732** in `libxml2`, HIGH severity, fixed upstream in
`2.13.9-r1`. The `web` image came with `2.13.9-r0` inherited from the
`nginx:alpine` tag that Docker official had not yet rebuilt with the patch.

### Fix

Add `apk upgrade --no-cache` to the Dockerfiles that install packages from the
Alpine index:

- `docker/web.Dockerfile` (base `nginx:alpine`) — before the `COPY` of configs,
  so the `nginx` package + its transitive deps (`libxml2`) bump to the latest
  available patch version.
- `docker/allinone.Dockerfile` (base `node:24-alpine`) — same pattern, before
  the `apk add nginx supervisor wget`. Guarantees that the installed `nginx` is
  built against the already-patched libs.
- `docker/api.Dockerfile` stays the same — it does not install Alpine packages
  (only node + pnpm via corepack) and the api Trivy scan was passing green.

Expected result: the `Trivy scan — web` job of the `docker-scan.yml` workflow
goes back to green. The rest of the release pipeline (already green in
alpha.15) stays the same.

### NO functional changes

- Collab keeps working the same (Hocuspocus 2.x).
- Tests 260/260 green (the Trivy fixes are at the image level, not code).
- The smoke gate keeps working.

## [1.0.0-alpha.15] — 2026-06-01

**Fix of the smoke gate** introduced in alpha.14. The alpha.14 image was
published on Docker Hub and worked (sync OK), but the release's `smoke` job
failed due to a script bug:

  Smoke threw: ERR_MODULE_NOT_FOUND '@hocuspocus/provider'

Cause: the script lived in the monorepo root `scripts/`. Node ESM resolves
`import 'bare-name'` against the script's directory (`scripts/`), not against the
cwd. And `scripts/` has no `node_modules` of its own — the providers live in
`apps/api/node_modules`.

### Fix

- Move `scripts/post-release-smoke.mjs` → `apps/api/scripts/post-release-smoke.mjs`.
  Now the `import '@hocuspocus/provider'` resolves naturally against
  `apps/api/node_modules`.
- Update `.github/workflows/release.yml` to invoke `node
  scripts/post-release-smoke.mjs` with `working-directory: apps/api`.
- Doc reference updated in `docs/PATTERNS.md` §8.

### Local verification before the push

```
$ cd apps/api && node scripts/post-release-smoke.mjs 1.0.0-alpha.14
✓ postgres ready
✓ app responsive on :35173
✓ note created via REST (id=…)
✅ WS sync verified: client received "smoke seed text"
```

The smoke now does what it promised to do: pull the published tag, bring it up
in a container, connect as a real WS client, verify the sync works. If it fails,
the GitHub Release is skipped and the operator sees the red in the workflow.

## [1.0.0-alpha.14] — 2026-06-01

**A complete and honest collab test plan.** After the alpha.11 incident
(collab in-process green / collab WS broken in production), we close the QA
process gaps for real.

### New Layer 3 tests — REAL WebSocket transport

`describe('collab integration: REAL WebSocket transport', ...)` block in
`apps/api/src/collab.integration.test.ts`. These use a real `HocuspocusProvider`
over `ws://` (NOT `openDirectConnection`), so they exercise exactly the same
path as a browser:

- `two real clients see each others edits via WS sync` — core regression of the
  bug that left the editor empty.
- `awareness state propagates between two real WS clients (cursors/users)` —
  covers presence + remote cursors, which in alpha.11 were also silently broken
  by the same transport bug.
- `a real WS client receives an applyServerEdit broadcast in real time` —
  covers the MCP write path with a real WS, not DirectConnection.

Total: 260/260 green.

### Playwright in CI — `e2e.yml`

New workflow that on every PR + push to `main`:

1. Brings up `docker compose up -d --build` (full stack: db + api + web).
2. Installs chromium on the runner.
3. Runs `apps/web/e2e/collab.spec.ts` which opens two `BrowserContext` on the
   same note and verifies synced edits + the presence chip.
4. On failure: dumps each container's logs + uploads the HTML report as an
   artifact (7-day retention).

### Post-release smoke against Docker Hub — new job in `release.yml`

After `build-and-push` and before `finalize`, a new `smoke` job:

1. Pulls the exact tag we just published (`soydiloreto/diluxite:X.Y.Z`).
2. Brings up postgres + the all-in-one container on a temporary Docker network.
3. Waits for health checks.
4. Creates a note via REST.
5. Opens a real `HocuspocusProvider` against the container's `/collab`.
6. Verifies the initial sync receives the seeded content.

If the smoke fails, **the release workflow fails**: the operator sees the red and
knows that `:next` (rolling) points to a broken image before Watchtower brings it
down to users. This closes the gap that let alpha.11 through.

Standalone script: `scripts/post-release-smoke.mjs <version>`. Useful manually:
`node scripts/post-release-smoke.mjs 1.0.0-alpha.X`.

### Doc — `docs/PATTERNS.md` §8 (new section)

Written rule: tests with `openDirectConnection` do NOT count as a test of the WS
transport. Any change in Hocuspocus version, transport library, or the WS path
of `applyServerEdit` requires updating the `REAL WebSocket transport` block. The
history of the alpha.11 incident is documented as justification.

## [1.0.0-alpha.13] — 2026-06-01

**Fix of the "creating a new note does not appear without F5" bug** (reported in
real use). The note persisted OK to the backend; what did not work was the tab
opening in the frontend.

### Root cause

`openNote(id)` reads `notes` from its React closure (the `useCallback` deps
include `notes`, so the version used is from the last render). In the flow of
`createNote()`:

```ts
const n = await api.createNote(...);
await refresh(spaceId);    // schedules setNotes(...) — React batched
openNote(n.id);             // runs NOW, notes in its closure is the old one
                            // → notes.find(id) → undefined → tab does NOT open
```

The sidebar DID reflect the note (it consumes `notes` from the context, which
updates on the next re-render), but the tab was left unopened. Refreshing the
page (F5) re-hydrated the whole state from `/api/info` + listNotes, and the tab
opened from the route.

### Fix

- `openNote(id, noteHint?: Note)`: optional parameter to pass the note directly
  and skip the `notes.find()` when we already have the fresh reference (the
  `createNote` case).
- `createNote()` and `openByTitle()`: do an **optimistic insert** into `notes`
  before calling `openNote(n.id, n)`. The `refresh(spaceId)` that reconciles with
  the server becomes fire-and-forget (`void refresh(...)`) because we do not need
  to wait for it.

### Other changes

None. Focused hotfix.

## [1.0.0-alpha.12] — 2026-06-01

**Critical hotfix for the collab that did NOT work in alpha.11.** Diagnosed
live: the editor was left empty after opening any note (the preview did show the
text). Technical symptom: the client's WebSocket connected to `/collab`, but the
initial sync never arrived — the server accepted the upgrade and did not send the
state. It was the Hocuspocus 4.x bug with `crossws` that had already bitten in
the Sprint 1 tests (where I avoided it using `openDirectConnection`); in
production, against real clients, it simply does not work.

### Fix

- Downgrade `@hocuspocus/server` and `@hocuspocus/provider` from `^4.1.0` to
  `2.15.3` — the last version that uses the `ws` library directly, without
  `crossws`. Minor API change: `new Hocuspocus()` + `.configure({...})` +
  `.listen(port)` instead of `new Server({...})` + `.listen()` with manual
  `configuration.port`.
- We removed the server's `onAuthenticate` hook. In Hocuspocus 2.x, having it
  registered activates `requiresAuthentication: true`, which rejects any client
  without an explicit `token` in the query string. Our browser clients identify
  by session cookie (which travels in the handshake automatically as a header).
  We moved the auth resolve to `onLoadDocument`, which has access to the
  `requestHeaders` all the same and is NOT gated by the handshake's "must have
  token".
- Tests: added a `REAL WebSocket sync` integration test that opens a real
  HocuspocusProvider against a Hocuspocus 2.x over `ws://`, verifies that the
  initial sync completes and the yText receives the seeded content. This is the
  regression-proof so I do not get stuck on the `@hocuspocus/server` version
  again in the future.

### Tests

257/257 green (+1 regression test of the real WS).

## [1.0.0-alpha.11] — 2026-06-01

Still alpha. Brings real-time collaborative editing (Yjs + Hocuspocus), six
sprints of work aggregated into a single line of development
(`feature/yjs-collab`), merged here. We keep the `alpha` tier because the
feature just landed and we want to keep iterating with the freedom to make
breaking changes on internal surfaces. Jumping to `beta` will happen once the
engine settles for a couple of releases without surprises.

### Collaborative editing (Yjs + Hocuspocus)

- **Engine**: `Y.Doc` per note, `Y.Text` as the source of truth during an active
  session. Hocuspocus 4.1 serves documents over WebSocket (port 3031).
  Persistence in `notes.yjs_state bytea` with `yjs_updated_at`; when nobody is
  editing, we derive markdown to `notes.content_md` so MCP / search / export keep
  seeing the same text.
- **Editor**: migrated Monaco → **CodeMirror 6** + `y-codemirror.next` +
  awareness. The production bundle dropped from 4.5 MB to 1.4 MB (−3 MB raw,
  −746 KB gzip). Named, colored remote carets rendered by the binding with no
  extra code.
- **Presence**: an avatar chip in each note's header — initials, deterministic
  color by user identity (FNV-1a hash → HSL), self marked with (you) and reduced
  opacity, `+N` overflow.
- **Live broadcast from MCP**: `applyServerEdit` detects whether the note has a
  loaded Y.Doc and opens an `openDirectConnection` so the mutation appears live
  in the connected clients. Without a live doc, it falls back to the traditional
  DB path. Covered by an integration test.
- **No offline edits** (product decision): when the WS drops, `editable` is
  reconfigured to `false` and a red banner appears "🔴 Disconnected…". Automatic
  reconnect with the provider's exponential backoff. If the session expires, a
  different banner "🔒 Your session expired…" with an instruction to refresh.
- **Runtime config**: `/api/info` returns `collabUrl` (default `/collab`; null if
  `DILUXITE_COLLAB_DISABLED=1`; absolute override with
  `DILUXITE_COLLAB_PUBLIC_URL`). The frontend requires no build env vars — the
  same web image serves collab on/off.
- **nginx routing**: `/collab` location added to `nginx.allinone.conf` and
  `nginx.conf` (sibling mode), with Upgrade headers + read_timeout 1d so as not
  to break idle awareness pings.
- **GC**: we rely on native Yjs (`gc: true` default + snapshot encode on every
  save). Documented in `collab.ts`.

### Tooling

- **Batch migration CLI** (`apps/api/src/migrate-yjs-cli.ts`): idempotent, seeds
  `yjs_state` for all legacy notes with non-null `content_md`. Useful after an
  upgrade from `alpha.x`. The lazy seed in `onLoadDocument` also covers them
  on-demand.
- **Playwright E2E** (`apps/web/e2e/collab.spec.ts`): multi-context chromium
  suite — text typed in context A appears in context B + the presence chip. Does
  NOT run in CI yet (browsers + stack up), local with
  `pnpm --filter @diluxite/web e2e`.
- **Opt-out**: `DILUXITE_COLLAB_DISABLED=1` skips the :3031 listener + returns
  `collabUrl: null` in `/api/info`. For single-user installs or environments
  with the port taken.

### Tests

256/256 green across core + db + api integration + web unit. +18 new tests for
collab (9 unit + 5 integration + 4 components + auxiliaries).

### Breaking changes

- **None**. Existing notes hydrate from `content_md` automatically on the first
  collaborative open. The editor changes visually (CM6 instead of Monaco) but the
  external contract (markdown source) is identical.

### Migration

```bash
# After pulling the 1.0.0-beta.0 image:
docker compose pull && docker compose up -d
# Optional, but recommended to avoid lazy seeds:
docker exec -it diluxite-api pnpm exec tsx /app/apps/api/src/migrate-yjs-cli.ts
```

## [1.0.0-alpha.10] — 2026-06-01

Closes the "creating a note takes 5 seconds" bug. It was an Ollama cold-start:
by default the provider unloads the model from RAM after 5 min idle, so the
first note after any pause paid the full model load (3-5s for
`mxbai-embed-large`). Diluxite's usage pattern (short intermittent sessions
throughout the day) fell right into this worst case.

### Fix

- `OllamaEmbeddingProvider` now sends `keep_alive: '24h'` on every request
  (configurable via the `keepAlive` opt). Ollama keeps the model loaded between
  calls, eliminating the cold-start. Cost: ~600 MB of constant RAM in the Ollama
  process (acceptable on any machine with ≥4 GB).
- Unit tests for the default `'24h'` and for a custom override (`'-1'` = forever,
  `'5m'` = legacy behavior).

## [1.0.0-alpha.9] — 2026-06-01

Closes another bait-and-switch: the "auto-update via Watchtower" that the README
promised did NOT work — the installer pinned the image to the exact version
(`:1.0.0-alpha.X`), so even if you brought up Watchtower with `--profile
autoupdate`, it updated nothing (pinned tags do not receive rolling updates). Now
the installer asks up front and configures the compose accordingly.

### Installer — new Step 6 / 9: Auto-update
- Default **Yes** (opt-out), the "always up to date" philosophy. The user can
  answer `N` if they prefer strict reproducibility.
- **Auto-update ON**: the compose uses the rolling tag (`:next` or `:latest`
  depending on the Step 5 channel) and brings up Watchtower as a default service.
  Watchtower checks every 6 h and reconciles. No user action.
- **Auto-update OFF**: the compose pins the exact version (e.g. `1.0.0-alpha.9`)
  and leaves Watchtower behind the `autoupdate` profile (opt-in via `docker
  compose --profile autoupdate up -d`). The yellow banner in the UI notifies when
  there is a new one.
- Messages in EN/ES/PT.
- The installer's final summary now shows "Auto-update: ON / OFF" and the useful
  commands change with the choice (hides `--profile autoupdate` when it is
  already ON, adds "force update now" instead).

### Compose template
- New `__WATCHTOWER_PROFILES__` placeholder that the installer replaces with
  empty (Watchtower always up) or with `    profiles: ["autoupdate"]` (legacy
  opt-in).
- Comments updated.

### Step renumbering
- All steps now go `X / 9` (there used to be an inconsistency: steps 1-5 said
  `/ 7`, steps 6-8 said `/ 8`, not counting server mode). Now always `/ 9`.
- Step 6 = the new Auto-update. Step 7 = Mode (was 6/8). Step 8 = Generating (was
  7/8). Step 9 = Starting (was 8/8).

### README
- The "Update" section rewritten: it documents the two flows per the installer's
  choice, instead of presenting only the manual opt-in.

[1.0.0-alpha.9]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.9

## [1.0.0-alpha.8] — 2026-05-31

Closure of the "local = single-tenant" invariant + organization-creation UI in server mode.

### Backend — mode guards (no bait-and-switch)
- `POST /api/organizations` and `DELETE /api/organizations/:orgId` now return `403 { error: 'organization creation/deletion requires server mode' }` when `deps.info?.authMode !== 'server'`. The guard runs **before** validating the body (no leakage of the mode via different error messages).
- `POST /api/organizations/:orgId/tokens` and `DELETE /api/organizations/:orgId/tokens/:id` get the same treatment (`org tokens require server mode`). In local mode, the personal API keys (`/api/api-keys`) already cover the single-user case; org tokens would be redundant. `GET` stays open (read-only, useful for inspection).
- **Fail-closed**: if `deps.info` is undefined, the 4 endpoints also return 403. Better to refuse than to allow silently.
- New test suite `auth-mode-org-guards.integration.test.ts` with 11 cases (local rejects, server allows, info missing rejects, org tokens guard).

### Backend — `/api/info` now exposes authMode + the actual version
- It was already propagated via `{ ...base }` from `services.ts`; now the client consumes it.
- **Pre-existing bug fixed**: `services.ts` hardcoded `version: '4.1.0-alpha.0'` (drift from several alphas back). Now it is read from `apps/api/package.json` via `import pkg from '../package.json' with { type: 'json' }` — `/api/info.version` always matches what is deployed.

### Frontend — UX that reflects the mode
- The `Info` interface (API client) + `AppCtx` + `App.tsx` boot read `authMode: 'local' | 'server'`.
- `OrganizationTab`: the "Danger zone" is still shown for super_admins, but the "Delete organization" button is **disabled + tooltip "Requires server mode"** in local, with an explanatory note below. The UI never goes beyond what the API permits.
- `OrgTokensTab`: in local mode it hides the mint form and shows a note directing the user to the personal API keys in Settings → MCP connection. The listings + revoke remain visible if there are legacy tokens.
- `OrgIndicator`: in server mode the dropdown opens even with a single org and shows a "+ New organization" footer. The new `createOrgFlow` in `App.tsx` uses `useDialogs.prompt`, calls `api.createOrganization`, refreshes, and switches to the newly created org.
- `fakeApi` now respects the mode (default `local`, opt-in `{ authMode: 'server' }`) — the multi-tenant methods (`createOrganization`, `deleteOrganization`, `mintOrgToken`, `revokeOrgToken`) throw `HTTP 403` in local, simulating the real backend. This prevents a new dev from reading the mock as "always allowed" and building flows the real API would reject.

### Installer — robust Ollama install on macOS
- The official Ollama installer ends with `open -a Ollama`, which fails with "Unable to find application named 'Ollama'" when LaunchServices has not indexed the just-copied app. The Diluxite installer now tolerates that non-zero exit on macOS and adds `ensure_ollama_running` with retries before the first `ollama pull` (also covers "Ollama installed but daemon off").

### Testing
- 3 unit tests for `OrganizationTab` (local disabled, server enabled, non super_admin no danger zone).
- 5 unit tests for `OrgIndicator` (local 1 org, local N orgs, server 1 org, server N orgs, without the onCreate prop).
- 1 unit test for `OrgTokensTab` in local mode (mint form hidden + note visible).
- 11 integration tests for the mode guards of `/api/organizations` + `/tokens` (local + server + fail-closed). Local coverage: 13 files / 90 tests green against real Postgres, zero regressions.

[1.0.0-alpha.8]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.8

## [1.0.0-alpha.7] — 2026-06-01

Release with the plan's 7 integrated phases: org tokens + login UI + installer mode + end-to-end passkeys.

### Org tokens (Phase 5 + 6)
- `tokens.user_id` is now nullable + a new `tokens.org_id` + `scopes text[]` (migration 0005) with a CHECK XOR.
- Endpoints `POST/GET/DELETE /api/organizations/:id/tokens` (require admin/super_admin), validates scopes (`read`|`write`|`admin`|`space:<id>`|`org:<id>`).
- `DrizzleTokensRepository`: `createOrgToken / listForOrg / revokeOrgToken / resolveToken`. `findUserIdByToken` now filters to tokens with `user_id NOT NULL` (legacy auth ignores org tokens automatically).
- New UI `OrgTokensTab` in the Admin Console with scope badges + revoke; `'My API keys'` (api-keys, member+) and `'Org tokens'` (org-tokens, admin+) split in the sidebar.

### Login UI (Phase 7)
- `LoginScreen` (full-page email + password) + an `AppGate` wrapper in `main.tsx` that probes `/api/info` at boot. Local mode passes through it; server mode without a session → shows login before anything else.
- `ApiClient.login / logout`.

### Installer local/server mode (Phase 8)
- `install.sh` new step 6/8: choose local mode (passwordless) or server. If server, asks for email + password with validation (email format, minimum 8 chars, confirmation match) and injects them as env vars `DILUXITE_AUTH_MODE` + `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` into the generated compose.
- `bootstrapServerAdmin` in `services.ts` applies the env vars on the first boot (idempotent, only if `password_hash` is NULL).
- 3 languages (EN/ES/PT) covered.

### Passkeys / WebAuthn (Phase 9 + 10)
- Schema (migration 0006): `passkeys` (credential_id, public_key, counter, device_type, label, transports, backed_up, last_used_at) + `webauthn_challenges` (transient state with TTL).
- `DrizzlePasskeysRepository` + `apps/api/src/passkey-routes.ts` with the 4 standard ceremonies (`register-options/verify`, `authenticate-options/verify`) using `@simplewebauthn/server`. Usernameless authentication: the user is resolved from the `credentialId` in verify, no email asked upfront.
- RP_ID / RP_ORIGIN configurable via env. Defaults `localhost`+`http://localhost:5173` for dev.
- Server mode only; local mode returns a clean 404.
- `GET /api/passkeys` + `DELETE /api/passkeys/:id` for management from the UI.
- UI: `PasskeysTab` in Settings (Add this device + list + revoke) + a "Sign in with a passkey" button in `LoginScreen`.
- Dependencies: `@simplewebauthn/server` (api) and `@simplewebauthn/browser` (web, dynamic import).

### Bugs (Phase 1.b)
- Delete organization no longer leaves the UI with `currentOrgId` pointing at a deleted org: `refreshOrgs` reconciles automatically and switches to the next available one.
- Switch org: confirmed it is not a bug — the dropdown only opens with ≥2 orgs (intended).

### Testing
- Tests per phase with TDD: `OrgTokensTab.test`, `LoginScreen.test`, `AppGate.test`. Total 124 tests / 21 test files in unit (web+core). Backend integration in CI with a `pgvector/pgvector:pg17` service container.

[1.0.0-alpha.7]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.7

## [1.0.0-alpha.6] — 2026-05-31

### Fixes
- **Delete organization** no longer leaves the UI in a phantom state: when you delete the active org, `refreshOrgs` reconciles automatically and switches to the first available one (or clears `localStorage` if none remain).

### Auth — `server` mode scaffolding (backend ready, login UI in the next release)
- New schema: `users.password_hash` (PBKDF2-SHA512, OWASP 210k iter) + a `sessions` table (opaque tokens, SHA-256 hash, TTL 30d).
- New schema in `tokens`: `user_id` is now nullable + `org_id` + `scopes text[]` + a CHECK XOR (a token belongs to a user **or** an org, not both). Migrations 0004 + 0005.
- `@diluxite/core`: `hashPassword` / `verifyPassword`, `SessionAuthProvider` (cookie session + Bearer fallback), `PasswordStore` / `SessionStore` interfaces.
- `services.ts`: reads `DILUXITE_AUTH_MODE` (default `local`). In `server`, it bootstraps the admin from the `DILUXITE_ADMIN_EMAIL` + `DILUXITE_ADMIN_PASSWORD` env vars (idempotent).
- `apps/api`: `POST /api/auth/login` and `POST /api/auth/logout` (HttpOnly cookie, SameSite=Lax). Clean 404 in local mode.

### UI
- **Settings moved to the avatar menu**: Connect AI, Appearance, Search preferences, MCP connection, About. The separate cogwheel in the Activity Bar was removed.
- **AI / Embeddings → Admin Console**: a new `Admin > AI / Embeddings` section with the active provider + the env vars to change it (instance-wide, requires restart + reindex).
- **Workspace selector moved to the right** next to the OrgIndicator: the "workspace → org" hierarchy reads at a glance.

### Pending for `v1.0.0-alpha.7`
- Login screen for `server` mode (UI).
- Endpoints + UI for org-level tokens (Phase 2.b — the schema is already ready).
- Passkeys / WebAuthn in `server` mode (Phase 4).

[1.0.0-alpha.6]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.6

## [1.0.0-alpha.5] — 2026-05-31

### Security — bundled npm purged from the runtime images

Trivy kept flagging 12 HIGH CVEs after the esbuild bump (alpha.4): they were not from Diluxite's code or its direct deps, but from the **npm bundled with `node:24-alpine`** (old vendored copies of `glob`, `minimatch`, `tar`, and pnpm itself). My pnpm overrides do not affect that tree (it lives in `/usr/local/lib/node_modules/npm/`, outside the workspace).

Definitive fix in a Docker layer:

```dockerfile
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx
```

Applies only to the `docker/api.Dockerfile` and `docker/allinone.Dockerfile` runtime stages (web.Dockerfile runtime is `nginx:alpine`, no Node). Diluxite does not use npm — it uses pnpm via corepack — so the `pnpm exec tsx` command keeps working.

Plus: pnpm bumped from 9.15.9 to 10.27.0 (closes CVE-2025-69262 RCE and CVE-2025-69263 lockfile bypass). Override of `glob`, `minimatch`, `tar` in `package.json` to force the latest in any transitive workspace dep.

[1.0.0-alpha.5]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.5

## [1.0.0-alpha.4] — 2026-05-31

### Security

- Bump `esbuild` 0.25.12 → **0.28.0** via pnpm `overrides` to close 4 HIGH/CRITICAL CVEs in the Go runtime esbuild was compiled with (CVE-2026-42499, CVE-2026-39836, CVE-2026-39826, CVE-2026-39825). esbuild arrives as a transitive dep of vite/tsx/vitest — the override forces the version across the whole tree.

[1.0.0-alpha.4]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.4

## [1.0.0-alpha.3] — 2026-05-31

### Dependencies — bump EVERYTHING to latest (8 majors)

- **typescript** 5.9.3 → 6.0.3
- **vite** 7.3.3 → 8.0.14 + **@vitejs/plugin-react** 4 → 6
- **vitest** 3.2.4 → 4.1.7 + **jsdom** 25 → 29
- **marked** 14 → 18 · **zod** 3 → 4
- **tailwindcss** 3.4.19 → **4.3.0** (+ the new `@tailwindcss/postcss`; `postcss.config.js` rewritten; `styles.css` uses `@import "tailwindcss"` + `@config` to preserve `tailwind.config.ts` without migrating to CSS-first)
- **@types/node** 22 → 25
- Patches: eslint, tsx, lucide-react, drizzle-kit

`tsconfig.base.json` updated: `lib` ES2022 → ES2023 + `types: ["node"]` (vitest 4 stopped injecting Node types implicitly). Zero visual changes in the UI. `pnpm outdated -r` now returns empty.

[1.0.0-alpha.3]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.3

## [1.0.0-alpha.2] — 2026-05-31

### Installer fixes (3)

- **Healthcheck**: the installer hit `/api/health` (does not exist) and `:3030/health` (port not exposed in the all-in-one compose). Now it checks `/api/update/check` via nginx on `:5173`, which IS the canonical "API + nginx + routing OK" signal.
- **`pnpm seed` in the container**: the script used `--env-file=.env` (REQUIRED), and `.env` does not exist in the image → tsx failed. Changed to `--env-file-if-exists=.env` (the container's env vars already suffice via `process.env`; `.env` only applies to local dev).
- **`scripts/` missing from the all-in-one image**: `docker compose exec diluxite pnpm seed` could not find `scripts/seed-demo.ts`. Added `COPY scripts scripts` in `docker/allinone.Dockerfile`.

[1.0.0-alpha.2]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.2

## [1.0.0-alpha.1] — 2026-05-31

### Distribution

- **All-in-one image published**: `soydiloreto/diluxite` (api + nginx + static web in one container via supervisord). The default installer uses this one — a single app container + Postgres. The separate `soydiloreto/diluxite-api` and `soydiloreto/diluxite-web` images are kept for scaling (Cloud, large orgs).
- **Unified installer** (single `install.sh`): supports Linux / macOS / WSL2 / Git Bash on Windows. Removed `install.ps1`. On Windows the user runs it from WSL2 or Git Bash.
- **Docker missing → browser + abort**: the installer opens the official download page in the user's browser (xdg-open / open / cmd.exe) and aborts without trying to install Docker silently.
- **Ollama auto-install**: if you choose Ollama and do not have it, the installer offers `curl ollama.com/install.sh | sh` with confirmation (default Y). On native Windows it opens the download page.
- **Docker Hub README automated**: each release pushes the corresponding README (`docker/hub-readme-{allinone,api,web}.md`) to each Docker Hub repo via the API (peter-evans/dockerhub-description). Only on stable releases — pre-releases do not churn the public page.
- **`release.yml` matrix expanded**: it now builds the 3 images in parallel (`allinone`, `api`, `web`) with `matrix.include` mapping each one to its Dockerfile + Docker Hub repo + README.
- **`docker-scan.yml`**: the Trivy scan now also covers the 3 images.

[1.0.0-alpha.1]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.1

## [1.0.0-alpha.0] — 2026-05-31

First public alpha. Diluxite is your AI's memory: Markdown notes + hybrid search (Spanish FTS + pgvector) + a native MCP server. Distributed via Docker Hub (`soydiloreto/diluxite-api` + `soydiloreto/diluxite-web`, multi-arch amd64/arm64). The Core edition (this repo) is open-source AGPL-3.0; the private Cloud edition hosts the same multi-tenant engine.

### Distribution and onboarding

- Images on Docker Hub published by release.yml when tagging `vX.Y.Z` (stable) or `vX.Y.Z-(alpha|beta|rc|dev)[.N]` (pre-release). Stable tags `:X.Y.Z + :X.Y + :latest`; pre-release tags `:X.Y.Z + :next`.
- `install.sh` installer (Linux / macOS / WSL2) and `install.ps1` (Windows + Docker Desktop): detects the platform, validates prerequisites (Docker daemon, Compose v2, free ports, ≥ 3 GB), asks where to store the data (bind-mount), which embedder to use (local Ollama with `mxbai-embed-large:335m` recommended, Azure OpenAI, or deterministic), and whether you want to start with an empty vault or a demo seed of 1500 notes. Pulls the images, brings up the stack, runs the seed if applicable.
- `docker-compose.template.yml` with placeholders + an opt-in `autoupdate` profile (Watchtower with `--label-enable`, 6 h poll, TZ Buenos Aires).
- `UpdateBanner` in the web: polls `/api/update/check` (compares the local version vs the repo's latest GitHub Release); `GET /api/update/check` endpoint in the API. Without exposing the Docker socket — the banner shows the command, the user runs it.

### Hardened CI / CD

- Separate workflows in the style of `wpm-user-sync` / `dilux-cloud-storage`: `lint.yml`, `typecheck.yml` (Node 20/22/24 matrix), `tests-unit.yml` (matrix), `tests-integration.yml` (with a `pgvector/pgvector:pg17` service), `version-alignment.yml` (the 5 `package.json` files + a literal entry in CHANGELOG).
- Security in 3 layers: `codeql.yml` (TS, `security-extended`, weekly on Monday), `security-audit.yml` (pnpm audit --prod --audit-level=high, weekly on Tuesday), `docker-scan.yml` (Trivy against both images with `severity HIGH,CRITICAL`, `ignore-unfixed`, weekly on Wednesday).
- `release.yml`: STRICT tag validation (rejects `1.0.0`, `v1.10`, `v1.0.0+meta`), verifies that the 5 `package.json` files match the tag, verifies a `## [X.Y.Z]` entry in CHANGELOG, multi-arch build with `docker/build-push-action` + GHA cache, push to Docker Hub, GitHub Release with `prerelease` auto-detected.
- `.github/copilot-instructions.md` with the full architecture, data model, search pipeline, anti-patterns, and review priorities (Copilot Code Review uses this file automatically).
- `.github/dependabot.yml` with grouping (npm prod + dev separate, github-actions, docker base images), weekly Buenos Aires.
- `CODEOWNERS`, PR template, issue templates.
- Branch protection on `main` with 4 required status checks + `required_conversation_resolution`.

### Engine

- **Pluggable embeddings** (`packages/core/src/providers.ts`): `DeterministicEmbeddingProvider` (default OSS), `OllamaEmbeddingProvider` (local, no keys, no cloud, `/api/embed` batch), `AzureOpenAIEmbeddingProvider`. `pickEmbedder()` in `apps/api/src/services.ts` with priority Azure > Ollama > deterministic by env.
- **Search pipeline**: tags + wikilinks + heading-aware chunking (512 / overlap 64) + `EmbeddingProvider.embed` + RRF (k=60) + pluggable reranker (`IdentityReranker` in Core, Cohere/cross-encoder in Cloud).
- **MCP server** Streamable HTTP, stateful by `Mcp-Session-Id`, 10 tools: `search_memory`, `list_notes`, `read_note`, `write_note`, `list_spaces`, `list_tags`, `search_by_tag`, `recent_notes`, `backlinks_of`, `append_to_note`.
- **Multi-tenant**: organizations + spaces + memberships; cross-tenant isolation by `space_id` in every query.
- **Frontend**: React 19 + Vite 7 + Tailwind + Dockview + Monaco + cmdk + lucide. VS Code-style shell (Activity Bar + Sidebar + Dockview + Status Bar). Cmd/Ctrl+K Quick Switcher. Editor with a Neighbors panel (outlinks + backlinks + suggested via pgvector) and movable splitters persisted in prefs.

### Security

- Bump `drizzle-orm` from 0.38.4 to 0.45.2 — resolves SQL injection [GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9).

[Unreleased]: https://github.com/soydiloreto/diluxite-core-alpha/compare/v1.0.0-alpha.0...HEAD
[1.0.0-alpha.0]: https://github.com/soydiloreto/diluxite-core-alpha/releases/tag/v1.0.0-alpha.0
