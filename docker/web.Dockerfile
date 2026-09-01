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
RUN corepack enable && corepack prepare pnpm@11.5.3 --activate

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

# nginxinc/nginx-unprivileged: misma imagen oficial de nginx pero el master
# corre como user `nginx` (uid 101), no root. pid + temp paths viven bajo
# /tmp (escribibles por el user) y el listen default es 8080. Nosotros
# escuchamos en 5173 (>1024, lo puede bindear un user no privilegiado), así
# que el master nunca necesita root. Antes usábamos nginx:alpine sin USER →
# el master quedaba como root (solo los workers bajaban a `nginx`).
FROM nginxinc/nginx-unprivileged:alpine AS runtime

# apk upgrade necesita root; volvemos a `nginx` antes del CMD. Trae los
# parches de CVEs de los libs transitivos (libxml2, openssl, etc.) que el
# tag publicado todavía no levantó del package index de alpine.
USER root
RUN apk upgrade --no-cache && rm -rf /var/cache/apk/*

# Diluxite's nginx config: serve SPA + reverse-proxy /api and /mcp to the
# api container. /mcp needs streaming-friendly settings (no buffering, no
# chunked-transfer interference) because it carries MCP Streamable HTTP.
#
# TODO(remediation): verificar con build real. La imagen unprivileged manda
# pid a /tmp/nginx.pid y los temp paths a /tmp (escribibles por uid 101) en
# su nginx.conf principal; nuestro snippet va a conf.d/default.conf y solo
# define el server. listen 5173 (>1024) lo bindea el user `nginx` sin root.
# Reemplaza el default.conf (listen 8080) que trae la imagen, sin conflicto.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
# Shared with the all-in-one image; both configs `include` it. See the file
# for why the headers live in nginx and not only in the API.
COPY docker/nginx-security-headers.conf /etc/nginx/security-headers.conf

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Volvemos al user no privilegiado para el runtime: el master de nginx
# arranca como `nginx`, no root.
USER nginx

# Port 5173 to match the dev experience (`vite dev` runs on 5173 too). Users
# get the same URL whether they're running `pnpm dev` or the published image.
EXPOSE 5173

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:5173/" >/dev/null 2>&1 || exit 1
