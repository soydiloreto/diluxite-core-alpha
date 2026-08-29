# Changelog

All notable changes to Diluxite Core are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

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
