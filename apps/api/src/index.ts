import { DrizzleYjsStateRepository, runMigrations } from '@diluxite/db';
import { buildApp } from './app';
import { buildCollabServer } from './collab';
import { buildCoreDeps } from './services';

const PORT = Number(process.env.PORT ?? 3030);
const COLLAB_PORT = Number(process.env.COLLAB_PORT ?? 3031);
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';

async function main() {
  await runMigrations(DATABASE_URL);
  const { sql, db, notesRepo, deps } = await buildCoreDeps(DATABASE_URL);
  const app = buildApp(deps);

  app.get('/health/db', async () => {
    const [{ has_vector }] = await sql<{ has_vector: boolean }[]>`
      select exists(select 1 from pg_extension where extname = 'vector') as has_vector`;
    return { db: 'ok', pgvector: has_vector };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🪨 Diluxite core en http://localhost:${PORT}`);

  // Collaborative editing — separate listener for the Yjs/Hocuspocus WebSocket
  // surface. nginx (in the all-in-one image) routes /collab to this port.
  const yjsRepo = new DrizzleYjsStateRepository(db);
  const collab = buildCollabServer({
    auth: deps.auth,
    notes: notesRepo,
    yjs: yjsRepo,
  });
  collab.configuration.port = COLLAB_PORT;
  collab.configuration.address = '0.0.0.0';
  await collab.listen();
  console.log(`🤝 Diluxite collab en ws://localhost:${COLLAB_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
