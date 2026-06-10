# Remediation plan

> Outcome of two full review passes + a full remediation pass on 2026-06-09
> (logic, security, tests, docs — 13 review agents + 6 fix agents over
> `v1.0.0-alpha.62`). **As of the remediation pass, P1/P2/P3 below are
> essentially all implemented** — the sections are kept as a record of what
> was done (see the per-item ✅ notes). Suite at the end: **917 vitest + 93
> installer + 2 e2e Playwright + live smoke (org tokens, RLS isolation,
> error handler, IDOR)**, typecheck + lint clean.
>
> ## Remediation pass — what got built (2026-06-09, third pass)
>
> - **Org tokens — fully implemented.** `Identity` is now a discriminated
>   union `{kind:'user'} | {kind:'org', orgId, tokenId, scopes}`. Org tokens
>   (`user_id NULL`) resolve via `resolveToken`, authorise through new
>   `requireReadSpace`/`requireWriteSpace` helpers with `read`/`write` scopes,
>   work over REST and MCP (the unattended-Action use case), default to
>   read-only, and are audited by `tokenId`. **Disabling/removing the user who
>   minted a token does not break it** (verified live + integration test).
>   User-only routes (sessions, TOTP, password, members) reject org tokens.
> - **Roles enforcement** — `viewer` can't mutate notes; an `admin` can't
>   demote/remove a `super_admin`; member POST goes through the atomic
>   orphan-guard; `POST /api/spaces` fallback checks org role.
> - **Soft-delete propagated** to graph/tags/keyword/vector/related (DB joins).
> - **RLS resync (migration 0019)** — `tokens_owner_or_org` policy makes org
>   tokens visible to org members; RLS enabled+forced on all post-0003 auth
>   tables; pre-identity tables (password_resets/webauthn_challenges/
>   oidc_ceremonies) are deny-by-default service-role-only (documented).
>   **A non-superuser role isolation test proves tenant isolation holds.**
> - **Migrations atomic** — `pg_advisory_xact_lock` + per-file transaction.
> - **CSRF bound to the session** (HMAC of the session token) — kills the
>   subdomain cookie-injection vector.
> - **Reset link** no longer falls back to the request `Origin` header.
> - **TOTP brute-force** — per-user lockout (IP-independent) + single-use
>   mfaToken with a nonce.
> - **Reindex endpoint** `POST /api/admin/reindex` (super_admin) — re-embeds
>   notes, idempotent; pairs with the boot dimension-mismatch warning.
> - **#11 grab-bag** — Bearer token of a disabled user → 401; OIDC/update-check
>   no longer reflect `e.message`; PUT returns fresh `contentMd`; org reads
>   unified to 404; login dummy-hash timing; passkey UV `required`; MCP SSE not
>   evicted while open.
> - **create space/org transactional**; `openOrCreate` atomic (unique index +
>   ON CONFLICT); `relatedToNote` ordered by distance; `timestamptz` on
>   expirations; audit index `text_pattern_ops`; `wouldOrphanSuperAdmin` under
>   `FOR UPDATE`.
> - **Core** — code fences no longer parsed as tags/wikilinks; CSV import
>   robust (blank line, quoted separator); otpauth `%20`.
> - **Web** — NotePanel keystroke loss, new-note stale closure, preview collab
>   banner, middle-click by id, TopBar exact-tag, RecentView range.
> - **Infra** — dev Postgres bound to 127.0.0.1; nginx web → rootless image
>   (TODO: verify in a real build); compose `chmod 600 + chown`. Still open:
>   moving compose secrets to a `.env` (deferred — needs a coordinated change
>   to the installer test suite that asserts the inline format).
>
> Remaining genuinely-open (small / owner's call): switch the production DB
> connection to the non-superuser role (the RLS layer is ready); the `.env`
> secrets migration for install.sh; the i18n hardcoded-strings coverage gap;
> the test-quality items in P3 (real `api.ts` client tests, shared truncate
> helper, flaky-timing cleanups, `docker compose config -q` in CI, broader
> e2e). The priority sections below are the historical record.

> Earlier framing (kept for reference): everything found is either fixed in
> section 0 or scheduled by priority. Suite after the second pass: **823
> vitest + 93 installer + 2 e2e Playwright**, typecheck + lint clean.

## 0b. Fixed in the 2026-06-09 SECOND pass (already in the tree)

The second pass dug into the least-reviewed surfaces (install.sh, OIDC/passkey/
CF-Access protocol flows, route-by-route API sweep, indexing pipeline, Docker/
CI, deep web + i18n) plus an adversarial review of the first pass's own diff.
Fixed, all with new tests:

- **OIDC account takeover (CRITICAL)** — callback never checked `email_verified`
  and blindly linked any pre-existing account by email, bypassing a local
  account's password+TOTP. Now: JIT requires `email_verified===true`; an existing
  `provider!=='oidc'` account with a password is refused (`different_signin_method`);
  passwordless pre-provisioned (csv_import) links only when verified
  (`oidc.ts`, `app.ts`).
- **IDOR cross-space via `folderId` (CRITICAL)** — note create/update never
  checked the folder belonged to the note's space. Now validated via
  `folders.spaceOf` → 400 (`app.ts`).
- **`active=false` not enforced (HIGH)** — disabled users could still log in
  with password/passkey and keep live sessions. Now enforced in
  `findUserIdBySession` (inner-join `users.active`), password login and
  passkey verify.
- **Collab write-path skipped indexing (HIGH, functional)** — `save_memory`
  then `search_memory` returned nothing; collaborative edits never re-chunked.
  Indexer now wired into `buildCollabServer` (live path) and into every
  `applyServerEdit` call site / cold path (`index.ts`, `collab.ts`, `app.ts`,
  `mcp.ts`). Verified live: create note → search finds it, tag extracted.
- **trustProxy regression (HIGH)** — yesterday's `req.ip` switch meant the
  installer's Caddy deploy keyed the login rate-limit by the proxy IP (5 fails
  lock the whole instance). Installer now emits `DILUXITE_TRUST_PROXY=1` behind
  Caddy.
- **No global error handler (HIGH)** — malformed UUID / DB errors leaked as 500
  with driver detail. `setErrorHandler` maps `22P02` + validation → 400, hides
  internals. Verified live: `/api/notes/not-a-uuid` → 400.
- **Graceful shutdown (HIGH)** — `docker stop`/Watchtower lost debounced Yjs
  writes. SIGTERM/SIGINT → `collab.destroy()` → `app.close()` → `sql.end()`;
  `tini` as PID 1 in `api.Dockerfile`.
- **install.sh secret mangling (HIGH)** — `sed` `&`/`\` and YAML `"`/`\n`
  silently corrupted the admin password / OIDC secret; `awk -v` mangled
  backslashes. Now escaped + round-trip verified. `--uninstall -y` no longer
  wipes data (needs explicit `--purge-data`); backup detects tar failure;
  restore uses `ON_ERROR_STOP`, restores `HTTPS_TLS_MODE`, defaults
  auto-update off; compose `chmod 600` + `chown`.
- **Input validation (MEDIUM)** — note `title`/`contentMd` type checks, audit
  `limit` clamp, array query-param normalization (all were 500s).
- **Rate-limits (MEDIUM)** — token mint, search, CSV import.
- **MCP session hygiene (MEDIUM)** — re-auth failure now 401 (no evict of
  others' sessions), unknown session → 404, `lastSeenAt` bumped on activity.
- **Embedder dimension guard (MEDIUM)** — boot warns loudly on a vector-dim
  mismatch (was a hard pgvector error mid-search); partial Azure/Ollama config
  warns instead of silently using deterministic embeddings; `seed-demo` reads
  the dim from env.
- **Web (MEDIUM)** — collab Ctrl+Z no longer undoes remote edits
  (`yUndoManagerKeymap`); navigating to /admin no longer destroys open tabs
  (DockShell always mounted as overlay); CSV import preview invalidated on
  edit; delete-active-workspace reconciliation; Search&Replace error handling +
  `$` escaping; dialog auto-focus; stale-fetch guards in Trash/Audit/Graph.
- **nginx** `client_max_body_size 4m`; all-in-one healthcheck off the
  network-dependent `/api/update/check`.

## 0. Fixed in the 2026-06-09 FIRST pass (already in the tree)

Security / correctness, all covered by new tests (suite went 763 → 800+):

- **Collab cross-tenant access** — `onLoadDocument` never checked space
  membership, and connections to an already-loaded doc were not
  authenticated at all (Hocuspocus skips `onLoadDocument` for hot docs).
  Now: `onConnect` authenticates + authorizes every connection, membership
  check mirrors `loadAuthorizedNote` (`apps/api/src/collab.ts`).
- **MCP sessions outlived their token** — only `initialize` resolved
  identity; revoked tokens kept working via `mcp-session-id`. Now: re-auth
  on every request, userId match, 30-min idle eviction (`apps/api/src/mcp.ts`).
- **MCP/PUT writes silently lost under collab** — `write_note`,
  `append_to_note` and `PUT /api/notes/:id` wrote straight to DB and the
  next Yjs flush overwrote them. Now routed through `applyServerEdit`
  (+ new `replaceWholeText` mutator).
- **Rate-limit bypass via spoofed `X-Forwarded-For`** — manual XFF parsing
  replaced by `req.ip` + opt-in `DILUXITE_TRUST_PROXY=1`.
- **Stored XSS in note preview** — `marked.parse()` output now passes
  through DOMPurify, wikilink `data-note` preserved (`apps/web/src/markdown.ts`).
- **CSRF missing in client** — `revokeAllTokens` (the panic button) and
  `registerPasskey` got 403 in server mode; both send `x-csrf-token` now.
- **Backup codes replayable** — `consumeBackupCode` was read-modify-write;
  now a single atomic `UPDATE … array_remove … RETURNING`.
- **Password-reset token double-use (TOCTOU)** — new atomic
  `consumeActiveByHash`; `/api/auth/reset` uses it.
- **`DELETE /api/spaces/:id` 500 with notes** — FK was `NO ACTION`;
  migration `0018` makes it `ON DELETE CASCADE`.
- **`findManyByIds` broken with ≥2 ids** — spread over Drizzle SQL objects;
  now `inArray`.
- **Chunking blow-up** when `overlap >= budget` (runaway near-duplicate
  chunks → embedding cost) — effective overlap clamped.
- **`verifyPassword` threw on malformed stored hash** (500 on login path) —
  fails closed now.
- **`TAG_RE` indexed markdown anchors** (`[x](#intro)` → tag `intro`) —
  negative lookbehind added.
- **Azure/Ollama embeddings** — response order/cardinality now validated
  (was silent wrong-vector assignment).
- **Collab broken in `pnpm dev`** — Vite never proxied `/collab`; added
  `ws: true` proxy to `:3031` (this is why local e2e failed before).
- **Secrets world-readable** — generated `docker-compose.yml` (admin
  password, OIDC secret, Azure key) now `chmod 600` (`install.sh`).
- Quick wins: `topK` clamp on `/api/search`, dead CSRF skip-list entries
  removed, MCP server version no longer hardcoded `4.0.0-alpha.0`,
  case-insensitive `Bearer`, missing `await` in trusted-header test,
  stray `3/` dir removed.
- **Docs**: 13 documents refreshed against the code (version, test counts,
  routes, tabs, env vars, SECURITY §10 rewrite, COMPARISON/PRD status
  tables, K8s ingress `/collab` + `/mcp`).

---

## P1 — security & correctness (next sprint)

1. **Org/role authorization gaps** (`apps/api/src/app.ts`)
   - `POST /api/spaces` without explicit `orgId` falls back to the caller's
     first org **without** the admin check (~1138). Apply `requireOrgRole`
     on the fallback too.
   - Member endpoints never look at the *target's* role: an org `admin` can
     demote/remove a `super_admin`, and `POST` (upsert) bypasses
     `wouldOrphanSuperAdmin` (~1082-1123). Check target role + orphan guard
     on POST.
   - `viewer` workspace role can create/edit/delete/purge notes — only
     member management enforces roles. Add `requireWorkspaceRole(['admin','editor'])`
     on mutations (~946 + every notes/folders/trash route).
2. **`active=false` not enforced** — ✅ DONE (second pass). Remaining: also
   gate **Bearer token** resolution on `active`, and actively revoke live
   sessions when an admin disables a user (today they expire by idle/TTL).
3. **Global error handler** — ✅ DONE (second pass; `22P02`/validation → 400,
   generic 500 body). Remaining: still scrub the OIDC error reflections
   (`app.ts:795,823`) and `/api/update/check` (~1437) that build messages from
   `(e as Error).message`.
4. **Soft-delete not propagated** (`packages/db`) — trashed notes still
   appear in `graph`, inflate `tags.listForSpace`, and burn candidate slots
   in `keywordSearch`/`vectorSearch`/`relatedToNote` (core post-filters, so
   no data leak, but results degrade). Join `notes.deleted_at IS NULL` in
   all five, or delete chunks/tags/links on trash + reindex on restore.
5. **RLS drift** (`migrations/0003` vs later schema) — `tokens_owner` policy
   predates org tokens; none of the post-0003 tables (sessions, passkeys,
   org_settings, oidc_ceremonies, audit_events, totp_secrets,
   password_resets) have policies; auth resolution runs outside
   `withIdentity`, so a non-BYPASSRLS role would break token auth entirely.
   Needs a dedicated migration + a documented strategy for auth tables, and
   a CI job that runs the suite under a non-superuser role.
6. **Manual migrations: no transaction, no lock** (`packages/db/src/migrate.ts:56`)
   — crash between `sql.unsafe(body)` and the tracking INSERT re-runs a
   non-idempotent file forever; two booting instances race. Wrap each file +
   INSERT in `sql.begin()` and take `pg_advisory_xact_lock`.
7. **JIT identity creation race** (`packages/core/src/auth.ts:200`) — two
   concurrent first-requests both call `createFromExternal` → unique
   violation 500 (or duplicates). Catch conflict + re-lookup (same pattern
   for `ensureForUser`, `upsertFromCsv`, `ensureSingleUserBootstrap` in
   `packages/db` — use `ON CONFLICT`).
8. **Indexer failure breaks note CRUD** (`packages/core/src/notes.ts:78,109`)
   — embedder down ⇒ create/update return 500 *after* persisting (retry ⇒
   duplicates). Decide the contract: catch + log + mark for re-index
   (eventually-consistent index) is the sane default.
9. **`/api/auth/forgot` breaks non-enumeration** (`app.ts:631`) — inline
   `await email.send()` 500s only when the email exists. Fire-and-forget
   with `.catch`, uniform reply.
10. **Passkey body parsing** (`passkey-routes.ts:81,149`) — unvalidated
    nested base64/JSON → 500. Validate shape, try/catch → 400.
11. **Cookies missing `Secure`** (`app.ts:230`, `csrf.ts:49`,
    `passkey-routes.ts:30`) — add `Secure` (env-conditional for plain-HTTP
    dev).
12. **MFA hardening** — `mfaToken` is replayable for its 5-min TTL (make it
    single-use via consumable jti, `mfa-tokens.ts:53`); signing-key fallback
    derives from the admin password (use HKDF; document
    `DILUXITE_MFA_SIGNING_KEY` as required in server mode). TOTP enroll
    accepts a client-chosen secret and enroll/disable don't require
    re-auth (`app.ts:391-455`); backup codes are 32-bit entropy →
    `randomBytes(8)` (`packages/core/src/totp.ts:80`).
13. **Org tokens are a dead feature** — minted with 201 (`app.ts:1753`) but
    no auth path accepts them (`findUserIdByToken` filters `user_id IS NOT
    NULL`; `resolveToken` has no callers; scopes never enforced). Wire them
    up or remove the endpoints — shipping a credential that silently never
    works is the worst option.
14. **`applyServerEdit` cold-path race** (`collab.ts:179`) — concurrent
    server edits on an unloaded doc are last-write-wins on `yjs_state`.
    Advisory lock per noteId, or always go through DirectConnection.
15. **Embedder change has no reindex** (`services.ts`, migration 0008) — the
    boot guard now WARNS on a dimension mismatch (second pass), but there is
    still no automated reindex or CLI/endpoint to migrate vectors when the
    operator switches embedder. Until then semantic/hybrid search stays broken
    after a switch. Build a `reindex` command that re-embeds every note.
16. **PUT returns stale `contentMd` under live collab** (`app.ts:1287`) — the
    response re-reads the row before the debounced flush, so it contradicts the
    just-applied edit. Build the response from `applyServerEdit`'s observed
    markdown (it already returns it; see its JSDoc).
17. **Org-read status inconsistency** — `auth-policy` returns 403 while `audit`
    and `requireOrgRole` return 404 for "not a member"; the web's
    `getAuthPolicy` treats 404 as "OIDC off" and misreads a 403. Unify
    org-scoped reads to 404 (`app.ts:1621,1722,997`).
18. **TOTP/backup brute-force is per-IP only** — no per-account attempt counter
    or lockout; distributed IPs bypass the 5/min. Add a `userId`-keyed counter
    (from the mfaToken) + lockout, and invalidate the mfaToken after N fails
    (`app.ts:326`).
19. **CSRF token not bound to the session** — pure cookie-mirror double-submit;
    a sibling-subdomain cookie injection forges a matching header. Bind it
    (HMAC of the session token) and verify the relation (`csrf.ts`).
20. **Body size limits** — Fastify has no explicit `bodyLimit` (default 1 MB)
    while nginx now allows 4 MB and CSV import claims 2 MB — the layers
    disagree. Set a coherent `bodyLimit` and cap note `title`/`content_md`
    length in create/update/append + MCP write (cost amplification: each
    append re-embeds the whole note) (`app.ts`).
21. **MCP SSE evicted by TTL sweep** — `lastSeenAt` only bumps on HTTP requests,
    so a long-lived SSE listener is evicted mid-stream by another client's
    request. Don't evict while the SSE response is open (`mcp.ts`).
22. **User enumeration by timing on `/api/auth/login`** — no dummy
    `verifyPassword` when the user doesn't exist; pbkdf2 runs only for real
    users. Run a constant-time dummy hash (`app.ts:285`).
23. **Passkey UV inconsistent** — options ask `userVerification:'preferred'`
    but verify defaults to requiring UV → non-UV authenticators fail
    verification. Align to `'required'` or pass `requireUserVerification:false`
    explicitly (`passkey-routes.ts`).
24. **Reset link host poisoning** — `DILUXITE_PUBLIC_WEB_URL` is never set by
    the installer/compose, so the reset link always falls back to the request
    `Origin` header (attacker-controllable). Require the config value in server
    mode; don't fall back to `Origin` (`app.ts:634`). Token stays hash-checked,
    so impact is limited to the link target.

## P2 — robustness & UX correctness

- **DB**: wrap space/org create (insert + admin membership) in a
  transaction; `relatedToNote` LIMIT cuts by `note_id` order instead of
  distance (subquery + ORDER BY distance); audit cursor should be
  `(at, id)`; `timestamp` → `timestamptz` on sessions/tokens/
  password_resets/oidc_ceremonies expirations; `deleteForUser` count check;
  `audit_events_action_idx` needs `text_pattern_ops` for the LIKE-prefix
  filter; composite FK `(folder_id, space_id)` so a note can't attach to a
  folder of another space; `wouldOrphanSuperAdmin` under `FOR UPDATE`.
- **Web**: workspace/org switch race (late response overwrites newer space
  — request-id guard or AbortController, also `GraphView`); NotePanel draft
  reset on `contentMd` updates loses keystrokes typed while a save is in
  flight (reset on `note.id` only + dirty check); stale closure in the
  global `diluxite:new-note` listener (ref pattern); preview-mode editor
  instance misses `onPresenceChange`/`onConnectionChange` (frozen collab
  banner); middle-click close resolves panels by title (not unique); TopBar
  tag filter matches substrings (`#azure` hits `#azure-devops`) — use
  `extractTags`.
- **Core**: `openOrCreate` TOCTOU (duplicate titles on concurrent wikilink
  follow); CSV import — leading blank line rejects the file, dead
  quote-strip code, `detectSeparator` ignores quoting; `otpauth://` URI uses
  `URLSearchParams` (`+` for spaces breaks some authenticators); strip code
  fences before tag/wikilink/heading parsing.
- **API misc**: folder `parentId` not validated (cycles A→B→A possible, FK
  500 on bogus ids); post-TOTP session created without ip/userAgent
  metadata; org endpoints mix 404/403/`200 null` for the same resource;
  MCP `reply.hijack()` without try/catch around `handleRequest` (hung
  socket on throw).
- **Infra**: dev compose binds Postgres on `0.0.0.0:5432` with trivial creds
  → bind `127.0.0.1`; nginx web image runs master as root → rootless image;
  consider `.env`-file secrets for the generated compose instead of inline.
- **Product decision**: folder delete hard-deletes child notes (bypasses
  Trash). Either route them through soft-delete or make the dialog warn
  explicitly (current copy is accurate but the asymmetry with note delete
  is surprising).
- **install.sh (second pass, lower severity, still open)**: `~`-paths not
  expanded (`mkdir "~/x"` makes a literal `~` dir); SQL-injection / breakage
  on an admin email containing `'` (use psql `-v`); HTTPS installs report a
  dead `localhost:WEB_PORT` in status/update (use the domain); menu mode
  disables `set -e` for all management code (check rc explicitly on
  psql/tar/pull/render); no trap/cleanup leaves half-installs and /tmp dumps
  with secrets; render destroys the existing compose if the template fetch
  fails (render to tmp + `config -q` + mv); restore sources the backup's env
  file (arbitrary code); Caddyfile invalid with an empty ACME email; reconfig
  "email" prompt erases on Enter. Full list in the install.sh review.
- **Web (second pass, still open)**: NotePanel preview-mode editor pins the
  tab on remote/initial-sync edits (pin only on local `userEvent`); RecentView
  `to` range frozen at mount hides newer notes; `Sidebar` reads
  `window.location` in render. (admin-destroys-tabs, collab undo, CSV preview,
  delete-workspace reconcile were FIXED in the second pass.)
- **i18n**: ~52 dead locale keys and ~half the UI (Trash/Recent/Search/admin/
  dialogs) hardcodes English instead of `t()`. The 6 locale files are
  perfectly key-synced; the gap is unused translation coverage, not missing
  keys. Wire the hardcoded strings to `t()` and prune dead keys.

## P3 — tests & tooling

- `apps/web/src/api.ts` (the real HTTP client) has zero tests — the whole
  web suite runs against `fakeApi`, so client/server drift goes green.
  Add fetch-mock tests (CSRF headers, error mapping, 401 handling). The two
  CSRF bugs fixed above would have been caught by exactly this.
- `PasskeysTab.tsx` has no test (every other security tab does).
- Shared truncate helper for the api project that includes `organizations`
  (today: 15 hand-rolled lists, org rows leak between runs, file-order
  dependency).
- Flaky patterns: `last_login_at` strict `>` after 30 ms sleeps; collab
  teardown fixed 50 ms sleep; `WorkspaceSelector` wall-clock assertion
  (<1000 ms) fails under parallel load on WSL2 — loosen or isolate.
- Installer suite (90 green) is fully mocked: add one CI step running
  `docker compose -f <generated> config -q` to catch invalid YAML.
- E2E covers only collab in local mode: add a server-mode login spec and a
  create/search/trash smoke; `afterAll` cleanup of `E2E collab note *`.
- Dedicated tests for `organizations-repository`, `sessions-repository`,
  `ensureSingleUserBootstrap` idempotency, `services.ts` embedder selection,
  `migrate-yjs-cli`, and migration re-run idempotency.
- Weak assertions sweep (`toBeTruthy` on `retry-after`, `expiresAt`, editor
  content) — assert real values.

## Suggested order

1. P1.1–P1.3 (authorization + error handler) — one PR, mostly `app.ts`.
2. P1.4–P1.6 (DB integrity: soft-delete joins, RLS migration, migrate.ts
   atomicity) — one PR with migration.
3. P1.7–P1.14 — small independent PRs.
4. P3's `api.ts` client tests + shared truncate helper early — they protect
   every later change.
5. P2 as background fixes alongside feature work.
