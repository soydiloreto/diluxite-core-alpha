# syntax=docker/dockerfile:1.7
# ===============================================================================
# Diluxite Web — production image.
#
# Stage `builder`: pnpm install + `vite build` produces a static SPA bundle
# under apps/web/dist (HTML + hashed JS + hashed CSS + assets).
#
# Stage `runtime`: nginx:alpine serves the static bundle AND reverse-proxies
# /api/* and /mcp/* to the sibling `api` container on the docker-compose
# network. This way the frontend only ever talks to its own origin — same-
# origin AJAX, no CORS, no env var needed at build time pointing at the API
# host. Cloud deployments can swap the upstream by mounting a different
# nginx.conf.
# ===============================================================================

FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/

# The web app has no workspace imports from core/db today — it talks to the
# API over HTTP. We still install with --filter so pnpm understands the
# workspace topology and resolves correctly.
RUN pnpm install --frozen-lockfile --filter @diluxite/web...

COPY apps/web apps/web

WORKDIR /app/apps/web
RUN pnpm build

# ─── Runtime ─────────────────────────────────────────────────────────────────

FROM nginx:alpine AS runtime

# Diluxite's nginx config: serve SPA + reverse-proxy /api and /mcp to the
# api container. /mcp needs streaming-friendly settings (no buffering, no
# chunked-transfer interference) because it carries MCP Streamable HTTP.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Port 5173 to match the dev experience (`vite dev` runs on 5173 too). Users
# get the same URL whether they're running `pnpm dev` or the published image.
EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:5173/" >/dev/null 2>&1 || exit 1
