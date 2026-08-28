# CodeQL triage — 2026-08-28

Every open code-scanning alert on `main` at this date, with a verdict and the
reasoning. 28 alerts (the pure dependency findings are excluded — those are
Dependabot's and were closed separately).

A verdict of **accepted** is not "we ignored it". It means someone read the
code, decided the alert does not describe a reachable defect, and wrote down
why — so the next person reads a decision instead of re-deriving it, and can
disagree with something concrete.

## Fixed

| # | Rule | Where | What was actually wrong |
|---|---|---|---|
| 224 | `js/polynomial-redos` | `app.ts` forgot-password | **The one that mattered.** `/^[^@]+@[^@]+\.[^@]+$/` puts a literal dot between two quantifiers whose class already contains the dot, so an address with no dot after the `@` makes the engine try every split — quadratic. It runs on `req.body`, where Fastify's 1MB default is the only bound, so ~1MB of `a` costs on the order of 10¹² steps from an unauthenticated endpoint. |
| 230 | `js/polynomial-redos` | `core/auth.ts` trusted-header | Same pattern, second copy. |
| — | (same class, not flagged) | `core/csv-users.ts` | Same pattern, third copy — found while fixing the other two. |
| 231 | `js/polynomial-redos` | `bearerToken` | `/^bearer\s+(.+)$/i`: `.` matches a space, so `\s+` and `.+` overlap and "bearer" + n spaces gives n ways to split. Header size caps the damage; the ambiguity was still real. |
| 229 | `js/polynomial-redos` | `cf-access.ts` | `replace(/\/+$/, '')` retries the anchored match from every position. The input is configuration, never a request — fixed for clarity, not exposure. |
| 240–242 | `js/prototype-polluting-assignment` | `mcp.ts` sessions | The MCP session map was a plain object keyed by the client's `mcp-session-id` header. CodeQL flagged the writes; the **reads** were sharper — `sessions['__proto__']` returns `Object.prototype`, a truthy non-session. |
| 225 | `js/log-injection` | `email.ts` noop provider | `to` was interpolated raw while the other fields were escaped. It is a user-supplied address on the forgot-password path, so a newline forges a log line. |
| 232–239, 7, 8, 221, 222, 226, 213 | `js/missing-rate-limiting` | 13 routes | Split — see below. |

The three email regexes are now one `isEmailShaped()` in core, and the fix is a
**length guard** (RFC 5321's 254 octets) rather than a cleverer pattern: it
bounds the cost whatever the regex looks like, and survives the next person
editing it. Rewriting the pattern alone would have fixed today's shape and left
the trap armed.

### The rate-limiting group, split by what the route actually is

**Fixed — 4 routes.** `POST /api/auth/totp/enroll` and
`/api/auth/totp/verify-enroll` are the auth surface: verify-enroll takes a
6-digit code, and being behind a session does not make that space large. Both
get the login family's 5/min. `GET /api/notes/:id/related` runs a vector scan
and `POST /api/notes/:id/append` is a write plus a full re-index, so both get
60/min — the same budget `/api/search` already carries for the same reason.

**Accepted — 9 routes.** The rest are ordinary authenticated CRUD on notes and
folders (`GET`/`PUT`/`DELETE /api/notes/:id`, restore, purge, backlinks,
folder update/delete, favorite). Each is already behind authentication AND
per-space authorisation, each is a single indexed query, and the caller can
only reach their own workspaces. A per-route budget here would throttle
someone editing quickly and buy nothing an attacker could not get by simply
using the product. This matches the repo's existing stance — rate limiting is
registered `global: false` and opted into where the cost or the brute-force
surface justifies it.

If that stance ever changes, the right move is a generous global budget, not
thirteen hand-placed ones.

## Accepted — false positives

| # | Rule | Where | Why it does not hold |
|---|---|---|---|
| 220 | `js/insufficient-password-hash` | `mfa-tokens.ts` | Not password hashing. It is an HMAC-SHA256 over `userId.expiresAt.nonce` with a 32-byte random key, signing a short-lived handoff token. HMAC-SHA256 is the correct primitive; the rule matches on shape, not on what the input is. A slow KDF here would be wrong, not safer. |
| 223 | `js/user-controlled-bypass` | `app.ts` TOTP verify | `if (code)` **dispatches** between the TOTP path and the backup-code path; it does not grant anything. `ok` starts `false`, is only assigned by `verifyTotpCode` or by a successfully consumed backup code, and `if (!ok)` refuses with a lockout counter. No value of `code` reaches success without passing the cryptographic check. |
| 243, 244 | `js/regex/missing-regexp-anchor` | `forgot-password.integration.test.ts` | Test code, pulling a token out of a captured email body. No attacker, no untrusted input. |
| 10 | `js/file-access-to-http` | `scripts/test-mcp.mjs` | A local development script. Not in the published images, not reachable from a request. |
| 218 | `js/indirect-command-line-injection` | `apps/api/scripts/post-release-smoke.mjs` | A release-time smoke script run by a maintainer against a tag they chose. Same reasoning: not shipped, no untrusted caller. |

The two script findings are the weakest "accepted" of the set: the reasoning is
about who runs them, not about the code being safe. If either ever gets called
from CI with a value from a pull request, the verdict flips and they should be
fixed rather than re-accepted.
