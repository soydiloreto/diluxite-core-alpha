#!/usr/bin/env node
/**
 * post-release-smoke.mjs — verifica que la imagen Docker Hub recién publicada
 * sirve un WebSocket de collab que completa el sync inicial con un cliente
 * real.
 *
 * Es el guardarriel que habría detectado el bug de alpha.11 antes de que el
 * tag `:next` quedara colgado de una imagen rota.
 *
 * Estrategia:
 *   1. Levantar postgres como sibling container.
 *   2. Levantar el all-in-one `soydiloreto/diluxite:<version>` apuntando al
 *      postgres anterior, con DILUXITE_AUTH_MODE=local.
 *   3. Esperar el healthcheck de /api/health.
 *   4. Crear una nota vía REST.
 *   5. Conectar un HocuspocusProvider real al /collab del container,
 *      verificar que el sync inicial trae el contenido seeded.
 *   6. Si pasa → exit 0. Si falla → exit 1, dump logs, no promueve :next.
 *
 * Uso: `node scripts/post-release-smoke.mjs <docker-tag>`
 * Ej.: `node scripts/post-release-smoke.mjs 1.0.0-alpha.13`
 *
 * Variables de entorno:
 *   - SMOKE_TIMEOUT_MS (default 30000): cuánto esperar al sync antes de
 *     fallar.
 *   - SMOKE_KEEP_CONTAINERS (default 0): si 1, no derriba los containers al
 *     final — útil para debugging local.
 */

import { execSync, spawnSync } from 'node:child_process';

const VERSION = process.argv[2];
if (!VERSION) {
  console.error('Usage: post-release-smoke.mjs <version> (e.g. 1.0.0-alpha.13)');
  process.exit(2);
}

const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
const KEEP = process.env.SMOKE_KEEP_CONTAINERS === '1';
const NET = `diluxite-smoke-${Date.now()}`;
const DB = `${NET}-db`;
const APP = `${NET}-app`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}
function shq(cmd) {
  return spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
}

function cleanup() {
  if (KEEP) return;
  console.log('\n── teardown ───────────────────────────────────');
  shq(`docker rm -f ${APP} ${DB} 2>/dev/null || true`);
  shq(`docker network rm ${NET} 2>/dev/null || true`);
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

console.log(`── smoke against soydiloreto/diluxite:${VERSION} ─────────────`);

try {
  sh(`docker network create ${NET}`);
  sh(
    `docker run -d --name ${DB} --network ${NET} ` +
      `-e POSTGRES_USER=diluxite -e POSTGRES_PASSWORD=diluxite -e POSTGRES_DB=diluxite ` +
      `pgvector/pgvector:pg17`,
  );

  // Wait postgres healthy.
  for (let i = 0; i < 60; i++) {
    const r = shq(`docker exec ${DB} pg_isready -U diluxite -d diluxite`);
    if (r.status === 0) break;
    if (i === 59) {
      console.error('postgres never became ready');
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('✓ postgres ready');

  // Pull + run the all-in-one image we want to validate.
  sh(`docker pull soydiloreto/diluxite:${VERSION}`);
  sh(
    `docker run -d --name ${APP} --network ${NET} -p 35173:5173 ` +
      `-e DATABASE_URL=postgres://diluxite:diluxite@${DB}:5432/diluxite ` +
      `-e DILUXITE_AUTH_MODE=local ` +
      `soydiloreto/diluxite:${VERSION}`,
  );

  // Wait app healthy on the exposed port.
  for (let i = 0; i < 120; i++) {
    const r = shq(`curl -fs http://localhost:35173/api/info`);
    if (r.status === 0) break;
    if (i === 119) {
      console.error('app never came up');
      shq(`docker logs ${APP}`).stdout && console.error(shq(`docker logs ${APP}`).stdout);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('✓ app responsive on :35173');

  // Make a note we can subscribe to.
  const space = JSON.parse(
    shq(`curl -fsS http://localhost:35173/api/spaces`).stdout,
  )[0];
  if (!space) {
    console.error('No space found — bootstrap problem');
    process.exit(1);
  }
  const created = JSON.parse(
    shq(
      `curl -fsS -X POST http://localhost:35173/api/spaces/${space.id}/notes ` +
        `-H 'content-type: application/json' ` +
        `-d '{"title":"smoke","contentMd":"smoke seed text"}'`,
    ).stdout,
  );
  if (!created.id) {
    console.error('Could not create note via REST');
    process.exit(1);
  }
  console.log(`✓ note created via REST (id=${created.id})`);

  // Now the actual contract: open a real HocuspocusProvider, wait for sync.
  const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import(
    '@hocuspocus/provider'
  );
  const Y = await import('yjs');
  const WS = (await import('ws')).default;

  const wsConn = new HocuspocusProviderWebsocket({
    url: 'ws://localhost:35173/collab',
    WebSocketPolyfill: WS,
  });
  const doc = new Y.Doc();
  const docName = `note:${created.id}`;
  let synced = false;
  new HocuspocusProvider({
    websocketProvider: wsConn,
    name: docName,
    document: doc,
    onSynced: () => {
      synced = true;
    },
  });

  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const text = doc.getText('markdown').toString();
    if (synced && text === 'smoke seed text') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalText = doc.getText('markdown').toString();
  if (finalText !== 'smoke seed text') {
    console.error(
      `❌ Sync FAILED. synced=${synced} text=${JSON.stringify(finalText)}`,
    );
    console.error('── container logs ──');
    console.error(shq(`docker logs ${APP}`).stdout);
    process.exit(1);
  }
  console.log(`✅ WS sync verified: client received "${finalText}"`);
  process.exit(0);
} catch (err) {
  console.error('Smoke threw:', err);
  process.exit(1);
}
