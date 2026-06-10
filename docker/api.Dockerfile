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
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

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

# Drop the npm that ships bundled with node:24-alpine BEFORE doing anything
# else. We do not use npm — only pnpm via corepack. npm bundles old copies
# of glob / minimatch / tar / its own pnpm which carry HIGH CVEs that
# Trivy flags. Removing the entire npm tree closes them at the source.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# tini como PID 1: reenvía SIGTERM al proceso real y cosecha zombies. Sin
# esto, `pnpm exec tsx` (PID 1) NO reenvía la señal y el graceful shutdown
# del API nunca corre — docker termina matando con SIGKILL al vencer el
# timeout. Ver ENTRYPOINT abajo.
RUN apk add --no-cache tini

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
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
