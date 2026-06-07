# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private reporting:
[**Report a vulnerability**](https://github.com/soydiloreto/diluxite-core-alpha/security/advisories/new)
(Security → Advisories → "Report a vulnerability").

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof of concept if possible).
- Affected version(s) / commit.

We aim to acknowledge reports within a few days. As an alpha-stage,
single-maintainer project, response times are best-effort — thank you for your
patience and for disclosing responsibly.

## Supported versions

Diluxite Core is in active **alpha**. Security fixes are applied to the latest
release on the `next` (pre-release) and `latest` (stable) channels. Pin to an
exact tag for reproducibility, but track the latest tag of your channel to
receive fixes.

## Scope & threat model

The self-host edition's threat model, trust boundaries, and the hardening
already in place (CSRF, rate limiting, audit log, 2FA/TOTP, session management,
PBKDF2 password hashing, verified Cloudflare Access JWT, etc.) are documented in
[`docs/SECURITY.md`](../docs/SECURITY.md).

A few operator responsibilities are **by design** and worth repeating:

- **Local mode** trusts anyone who can reach the web port — run it only on a
  machine/network you control.
- **Trusted-header** auth (plain proxy header) is only safe if **all** traffic is
  forced through your proxy; otherwise the header can be spoofed. Prefer the
  verified **Cloudflare Access (JWT)** mode, which is cryptographically safe.
- **Auto-update (Watchtower)** mounts the Docker socket = full host access. It is
  opt-in and the installer warns you before enabling it.
