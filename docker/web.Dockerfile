# syntax=docker/dockerfile:1.7
# Diluxite Web (Vite dev server) — exposed on :5173.
# Vite is run with --host 0.0.0.0 so the container is reachable from the host.

FROM node:24-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps/web apps/web

RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/web
EXPOSE 5173

CMD ["pnpm", "exec", "vite", "--host", "0.0.0.0", "--port", "5173"]
