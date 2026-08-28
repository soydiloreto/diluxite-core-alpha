# syntax=docker/dockerfile:1.7
# ===============================================================================
# Diluxite API + MCP server — production image.
#
# Stage `builder`: install the full pnpm workspace (with devDeps, because tsx
# lives there) restricted to @diluxite/api and its transitive deps via
# `--filter @diluxite/api...`. This brings in @diluxite/core and @diluxite/db
# automatically while leaving @diluxite/web out of the image entirely.
#
# Stage `runtime`: thin node:alpine with only what `builder` produced. We run
# the API directly with `tsx` (no separate TS→JS compile step) — the same way
# `pnpm dev` runs it. Reasons:
#   - Workspace TS imports across packages would otherwise need either tsc
#     --build or path mappings at runtime; tsx handles both transparently.
#   - The startup overhead of tsx vs. compiled node is ~150ms once; we ship a
#     long-running server, not a CLI.
#   - We trade a slightly larger image (~20MB of tsx + esbuild) for a much
#     simpler Dockerfile and zero divergence between dev and prod.
#
# If image size becomes a real constraint, swap stage `runtime` for a tsc
# --build + pnpm deploy --prod approach later.
# ===============================================================================

FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

# Workspace metadata first so pnpm install caches well.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/

# --filter @diluxite/api... resolves the dependency closure (core + db) and
# skips @diluxite/web. --frozen-lockfile pins to the committed pnpm-lock.yaml.
RUN pnpm install --frozen-lockfile --filter @diluxite/api...

# Now the source. Each package copied separately so a change in apps/api
# does not invalidate the layer that holds packages/core.
COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/api apps/api

# ─── Runtime ─────────────────────────────────────────────────────────────────

FROM node:24-alpine AS runtime

WORKDIR /app

# Drop every package manager that ships with node:24-alpine BEFORE anything
# else. The runtime launches the API with plain `node --import tsx` (see CMD),
# so npm, corepack and corepack's vendored pnpm are all unused here — and their
# bundled copies of glob / minimatch / tar / pnpm carry HIGH/CRITICAL CVEs that
# Trivy flags on the published image. Removing the trees closes them at the
# source, with no .trivyignore needed. (pnpm still does the install in the
# builder stage, which is discarded and never scanned.)
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/pnpm \
           /usr/local/bin/pnpx \
           /usr/local/bin/yarn \
           /usr/local/bin/yarnpkg

# `apk upgrade` brings the alpine base to the latest patch versions of the
# transitive libs (openssl/libcrypto, libxml2, etc.) so the trivy gate doesn't
# flag CVEs the alpine maintainers already fixed in the package index but the
# published `node:24-alpine` tag hasn't picked up yet. `web` and `allinone`
# have done this from the start; this image did not, which is why it was the
# only one of the three failing the scan (libcrypto3 CVE-2026-14456, an
# OpenSSL DoS fixed in 3.5.8-r0). Ignoring it was not an option: .trivyignore's
# own policy is that a CVE in code Diluxite runs against untrusted input is
# never ignored, and TLS/hashing is exactly that.
#
# tini como PID 1: reenvía SIGTERM al proceso real y cosecha zombies. Sin
# esto, el proceso `node` (PID 1) recibe la señal pero tini también cosecha
# los hijos que tsx pueda spawnear; mantiene el graceful shutdown del API
# antes del SIGKILL de docker. Ver ENTRYPOINT abajo.
RUN apk upgrade --no-cache && \
    apk add --no-cache tini && \
    rm -rf /var/cache/apk/*

# Non-root user — defence in depth. Even if a vulnerability gets remote code
# exec on the API, it lands as `diluxite`, not as root.
RUN addgroup -S diluxite && adduser -S diluxite -G diluxite

COPY --from=builder --chown=diluxite:diluxite /app /app

USER diluxite
WORKDIR /app/apps/api

ENV NODE_ENV=production \
    PORT=3030 \
    COLLAB_PORT=3031

# 3030 = REST + MCP (HTTP); 3031 = Hocuspocus WebSocket (collab editing).
# Both are exposed so the web image's nginx (sibling-container deploy) can
# reach them; the all-in-one image proxies both internally.
EXPOSE 3030 3031

# Healthcheck — used by both docker-compose and the deploy automation to know
# the API has finished migrating and is serving requests. The /health endpoint
# is intentionally cheap (no DB roundtrip); /health/db is what an external
# monitor should hit.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

# runMigrations() runs on boot; the api waits for db via the compose healthcheck.
# tini (PID 1) reenvía SIGTERM al árbol de procesos para que el graceful
# shutdown del API corra antes del SIGKILL de docker.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
