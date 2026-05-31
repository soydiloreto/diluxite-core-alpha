# Diluxite Web

**Frontend of [Diluxite](https://github.com/soydiloreto/diluxite-core-alpha) — the self-hosted memory for your AI.** React + Vite SPA served by nginx, with reverse proxy to a sibling API container.

- Repo · [github.com/soydiloreto/diluxite-core-alpha](https://github.com/soydiloreto/diluxite-core-alpha)
- Licence · AGPL-3.0
- Architectures · `linux/amd64`, `linux/arm64`

## When to use this image

You probably want the **all-in-one** ([`soydiloreto/diluxite`](https://hub.docker.com/r/soydiloreto/diluxite)) instead — that bundles API + web in one container and is the simpler default.

This separated image exists for scaling deployments where the web tier sits behind a CDN and the API runs as one or many [`soydiloreto/diluxite-api`](https://hub.docker.com/r/soydiloreto/diluxite-api) replicas.

## Quick start

See the compose example on the [diluxite-api image page](https://hub.docker.com/r/soydiloreto/diluxite-api) — both images go together.

## What's inside

- nginx (alpine) serving the React SPA bundle (Vite `production` build) on port `5173`.
- Reverse proxy:
  - `/api/*` → `http://api:3030` (REST)
  - `/mcp` → `http://api:3030` (MCP, streaming-friendly: `proxy_buffering off`, `chunked_transfer_encoding on`)
  - SPA fallback for client-side routing.
- Asset cache headers: 30d immutable on hashed files, `no-store` on `index.html`.

The upstream `api` hostname is resolved by Docker's embedded DNS inside a compose network. For deployments outside compose (Kubernetes, Nomad, manual), mount your own `/etc/nginx/conf.d/default.conf` pointing at your API service.

## Tags

`X.Y.Z` · `X.Y` · `latest` · `next` · `X.Y.Z-(alpha|beta|rc).N`. Tag in lockstep with `soydiloreto/diluxite-api`.
