# syntax=docker/dockerfile:1.7
# Diluxite API + MCP — run inside the docker-compose network.
# Built lean: only api + the packages it needs (core, db).

FROM node:24-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Workspace metadata first so pnpm install layers cache nicely.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps/api apps/api

RUN pnpm install --frozen-lockfile

WORKDIR /app/apps/api
EXPOSE 3030

# runMigrations() runs on boot; the api waits for db via the compose healthcheck.
CMD ["pnpm", "exec", "tsx", "src/index.ts"]
