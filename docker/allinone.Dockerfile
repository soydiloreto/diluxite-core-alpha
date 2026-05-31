# syntax=docker/dockerfile:1.7
# ===============================================================================
# Diluxite all-in-one — production image.
#
# Single container that runs:
#   - The Fastify API + MCP server on 127.0.0.1:3030 (loopback, internal).
#   - nginx on :5173 serving the React SPA AND reverse-proxying /api and /mcp
#     to the local API. From outside the container, the user only ever sees
#     port 5173 — there is no API URL to configure on the frontend.
#
# Process supervision: supervisord (alpine package, ~5MB). It launches both
# the API and nginx as foreground children, restarts either on crash, and
# exits the container if a child dies repeatedly. Patrón usado por n8n,
# gitea, ghost-docker.
#
# Why this image exists alongside diluxite-api + diluxite-web:
#   - Self-hosters with one machine want one container. This is that.
#   - Cloud / orgs that need to scale API replicas independently of the
#     web tier should use the separated images.
#
# Run it:
#   docker run -d -p 5173:5173 \
#     -e DATABASE_URL=postgres://diluxite:diluxite@db:5432/diluxite \
#     soydiloreto/diluxite:latest
#
# (plus a Postgres + pgvector container reachable as `db`; see README on
# Docker Hub for a complete docker-compose.yml snippet.)
# ===============================================================================

FROM node:26-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

# Install everything in one shot — we need both API workspace (with tsx) and
# the web workspace (with vite) to produce a runnable container.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/web apps/web
COPY scripts scripts

# Build the SPA — produces apps/web/dist/{index.html, assets/*}
WORKDIR /app/apps/web
RUN pnpm build

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime

# Drop the npm bundled with node:24-alpine (carries HIGH CVEs in its
# vendored copies of glob / minimatch / tar / pnpm — we use pnpm via
# corepack so npm itself is unused).
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

# nginx serves the SPA + reverse-proxies; supervisor keeps api + nginx alive;
# wget is used by the container HEALTHCHECK.
RUN apk add --no-cache nginx supervisor wget && \
    corepack enable && corepack prepare pnpm@10.27.0 --activate && \
    addgroup -S diluxite && adduser -S diluxite -G diluxite && \
    mkdir -p /run/nginx /var/log/supervisor /var/log/nginx && \
    chown -R diluxite:diluxite /var/log/supervisor /var/log/nginx /run/nginx

# Copy the api + its node_modules from the builder, owned by diluxite.
COPY --from=builder --chown=diluxite:diluxite /app /app

# Web bundle into nginx's default serve root.
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# nginx config for the all-in-one: proxy /api and /mcp to localhost:3030.
COPY docker/nginx.allinone.conf /etc/nginx/nginx.conf

# Supervisord config that brings up api + nginx and restarts each on crash.
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf

ENV NODE_ENV=production \
    PORT=3030

EXPOSE 5173

# Container is healthy once nginx is serving the SPA. /api/health proxies
# through to the API so we cover both procs with a single check.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:5173/api/update/check" >/dev/null 2>&1 || \
      wget -qO- "http://127.0.0.1:5173/" >/dev/null 2>&1 || exit 1

# supervisord runs as root because nginx needs to bind port 5173 (< 1024 is
# the historical concern; 5173 is fine) and to drop privileges for nginx
# workers. The api process is started by supervisord as user `diluxite`.
CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
