import Fastify from 'fastify';
import postgres from 'postgres';

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://diluxite:diluxite@localhost:5432/diluxite';

const sql = postgres(DATABASE_URL);
const app = Fastify({ logger: true });

// Salud del servicio
app.get('/health', async () => ({ status: 'ok', service: 'diluxite-core' }));

// Salud de la base + confirma que pgvector está instalado
app.get('/health/db', async () => {
  const [{ version }] = await sql<{ version: string }[]>`select version()`;
  const [{ has_vector }] = await sql<{ has_vector: boolean }[]>`
    select exists(
      select 1 from pg_extension where extname = 'vector'
    ) as has_vector`;
  return { db: 'ok', pgvector: has_vector, version };
});

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`🪨 Diluxite core escuchando en http://localhost:${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
