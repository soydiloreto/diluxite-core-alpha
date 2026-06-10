import { DrizzleYjsStateRepository, runMigrations } from '@diluxite/db';
import { buildApp } from './app';
import { buildCollabServer } from './collab';
import { buildCoreDeps } from './services';

const PORT = Number(process.env.PORT ?? 3030);
const COLLAB_PORT = Number(process.env.COLLAB_PORT ?? 3031);
// Set DILUXITE_COLLAB_DISABLED=1 to skip the collab listener. Useful for:
//  - Smoke-testing the api in isolation without bringing up the WebSocket.
//  - Environments where 3031 is reserved for something else and you don't
//    care about real-time editing (single-user local installs, mostly).
const COLLAB_DISABLED = process.env.DILUXITE_COLLAB_DISABLED === '1';

async function main() {
  await runMigrations(DATABASE_URL);
  const { sql, db, notesRepo, deps } = await buildCoreDeps(DATABASE_URL);

  // Collab plumbing — built upfront so the api endpoints can route MCP / REST
  // edits through the live Y.Doc when there are connected clients.
  let collabHandle: {
    hocuspocus: { documents: Map<string, { name: string }> };
  } | null = null;
  // Hold a reference to the live Hocuspocus instance for graceful shutdown
  // (so `destroy()` can flush any debounced onStoreDocument tick on SIGTERM).
  let collab: ReturnType<typeof buildCollabServer> | null = null;
  if (!COLLAB_DISABLED) {
    const yjsRepo = new DrizzleYjsStateRepository(db);
    collab = buildCollabServer({
      auth: deps.auth,
      notes: notesRepo,
      yjs: yjsRepo,
      // Per-space authorisation for every WS connection (RS-2).
      spaces: deps.spaces,
      // Reindex on every persist tick so collaborative edits (and cold MCP /
      // PUT writes routed through onStoreDocument) regenerate chunks / tags /
      // embeddings. deps.search is the SearchService, which implements
      // NoteIndexer. Without this, `save_memory` followed by `search_memory`
      // would never find freshly edited text.
      indexer: deps.search,
    });
    // Hocuspocus 2.x: listen(port) opens the http+ws server on 0.0.0.0:port
    // using the underlying `ws` library directly. No crossws indirection.
    await collab.listen(COLLAB_PORT);
    collabHandle = {
      hocuspocus: collab as unknown as {
        documents: Map<string, { name: string }>;
      },
    };
    deps.collab = {
      notesRepo,
      yjs: yjsRepo,
      hocuspocus: collabHandle.hocuspocus,
      // Same indexer the live onStoreDocument path uses, so the cold path
      // (applyServerEdit via PUT / MCP write when no client is connected)
      // also regenerates chunks/tags/embeddings.
      indexer: deps.search,
    };
  }

  const app = await buildApp(deps);

  app.get('/health/db', async () => {
    const [{ has_vector }] = await sql<{ has_vector: boolean }[]>`
      select exists(select 1 from pg_extension where extname = 'vector') as has_vector`;
    return { db: 'ok', pgvector: has_vector };
  });

  // Audit retention — opt-in via DILUXITE_AUDIT_RETENTION_DAYS. Sweeps hourly.
  const retentionDays = Number(process.env.DILUXITE_AUDIT_RETENTION_DAYS ?? '0');
  if (retentionDays > 0 && deps.audit) {
    const { startAuditRetention } = await import('./audit-retention');
    startAuditRetention(deps.audit, { retentionDays });
    console.log(`🧹 Audit retention: ${retentionDays} days`);
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🪨 Diluxite core en http://localhost:${PORT}`);
  if (collabHandle) {
    console.log(`🤝 Diluxite collab en ws://localhost:${COLLAB_PORT}`);
  } else {
    console.log('⏭️  Collab deshabilitado (DILUXITE_COLLAB_DISABLED=1)');
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // `docker stop` / Watchtower send SIGTERM. Without flushing, the last
  // debounced (~2s) Yjs edit tick is lost. Order matters: close collab first
  // so Hocuspocus.destroy() flushes pending onStoreDocument writes BEFORE we
  // tear down the DB pool they need; then the api; then the SQL connection.
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${signal} recibido — cerrando ordenadamente…`);
    try {
      // Hocuspocus 2.x: destroy() disconnects clients and flushes pending
      // docs (onStoreDocument). No-op path when collab is disabled.
      if (collab) await collab.destroy();
    } catch (e) {
      console.error('shutdown: collab.destroy() falló', e);
    }
    try {
      await app.close();
    } catch (e) {
      console.error('shutdown: app.close() falló', e);
    }
    try {
      await sql.end();
    } catch (e) {
      console.error('shutdown: sql.end() falló', e);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
