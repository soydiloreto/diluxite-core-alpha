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
  if (!COLLAB_DISABLED) {
    const yjsRepo = new DrizzleYjsStateRepository(db);
    const collab = buildCollabServer({
      auth: deps.auth,
      notes: notesRepo,
      yjs: yjsRepo,
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
    };
  }

  const app = await buildApp(deps);

  app.get('/health/db', async () => {
    const [{ has_vector }] = await sql<{ has_vector: boolean }[]>`
      select exists(select 1 from pg_extension where extname = 'vector') as has_vector`;
    return { db: 'ok', pgvector: has_vector };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🪨 Diluxite core en http://localhost:${PORT}`);
  if (collabHandle) {
    console.log(`🤝 Diluxite collab en ws://localhost:${COLLAB_PORT}`);
  } else {
    console.log('⏭️  Collab deshabilitado (DILUXITE_COLLAB_DISABLED=1)');
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
