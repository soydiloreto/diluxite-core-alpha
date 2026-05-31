<!--
Thanks for the PR. Fill in what applies, delete what doesn't.
This template is short on purpose — the rules of the road for this repo
are in .github/copilot-instructions.md.
-->

## What this PR does

<!-- 1–3 lines describing the change. Why, not just what. -->

## Linked issue / context

<!-- Closes #N, or paste a link to the spec / thread / runbook. -->

## How I verified it

<!-- Tick what applies. The relevant CI jobs will run automatically. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test:unit`
- [ ] `pnpm test:int` (postgres + pgvector running)
- [ ] Manual smoke in the UI (describe what you clicked)
- [ ] Tested with the MCP client (Claude / Copilot)

## Things a reviewer should look at

<!--
Anything subtle worth flagging: a tradeoff you made, a known limitation,
a follow-up you chose not to do. If you migrated DB schema, mention it
explicitly. If you changed an MCP tool's signature, mention it explicitly
(it's a breaking change for any connected client).
-->

## Versioning

- [ ] No version bump needed (internal change, no user-visible behavior).
- [ ] Patch bump (bugfix, no API change) — bumped in CHANGELOG + version-alignment job will verify.
- [ ] Minor bump (feature, backwards-compatible).
- [ ] **Major bump** (breaking change in API, MCP tools, DB schema, or env vars). I have noted this prominently above and in the CHANGELOG.
