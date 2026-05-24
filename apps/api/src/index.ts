import { runMigrations } from '@diluxite/db';
import { buildApp } from './app';
import { buildCoreDeps } from './services';

const PORT = Number(process.env.PORT ?? 3030);
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://diluxite:diluxite@localhost:5432/diluxite';

async function main() {
  await runMigrations(DATABASE_URL);
  const deps = await buildCoreDeps(DATABASE_URL);
  const app = buildApp(deps);

  // Salud de la base + pgvector
  app.get('/health/db', async () => {
    const [{ has_vector }] = await deps.sql<{ has_vector: boolean }[]>`
      select exists(select 1 from pg_extension where extname = 'vector') as has_vector`;
    return { db: 'ok', pgvector: has_vector };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`🪨 Diluxite core en http://localhost:${PORT}`);
  console.log(`🪨 Diluxite core en http://localhost:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
