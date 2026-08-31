import { defineConfig } from 'vitest/config';
import { databaseUrlFor } from './test/integration-db';

// Monorepo pnpm: cada proyecto tiene su `root` en el paquete, así Vitest
// resuelve las dependencias desde el node_modules de ese paquete.
// - 'core': tests de unidad (sin base de datos).
// - 'db'  : tests de integración (Postgres + pgvector, con globalSetup).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          root: './packages/db',
          include: ['src/**/*.integration.test.ts'],
          environment: 'node',
          // Su propia base. Los proyectos corren en paralelo entre sí y esta
          // suite trunca `users`, `notes`, `spaces` y `organizations` entre
          // casos — compartiendo base le sacaba las filas de abajo a la suite
          // de `api` en pleno test. Ver `test/integration-db.ts`.
          env: { TEST_DATABASE_URL: databaseUrlFor('db') },
          globalSetup: ['./test/setup-integration.ts'],
          pool: 'forks',
          // One process, one file at a time: these share a single Postgres
          // and truncate between cases. `fileParallelism: false` is what buys
          // that in Vitest 4 — it pins maxWorkers to 1. The old
          // `poolOptions: { forks: { singleFork: true } }` said the same thing
          // in the 3.x dialect and Vitest 4 removed it, so it was being read
          // by people and ignored by the runner.
          fileParallelism: false,
          hookTimeout: 30000,
          testTimeout: 30000,
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          include: ['src/**/*.integration.test.ts'],
          environment: 'node',
          env: { TEST_DATABASE_URL: databaseUrlFor('api') },
          globalSetup: ['./test/setup-integration.ts'],
          pool: 'forks',
          // One process, one file at a time: these share a single Postgres
          // and truncate between cases. `fileParallelism: false` is what buys
          // that in Vitest 4 — it pins maxWorkers to 1. The old
          // `poolOptions: { forks: { singleFork: true } }` said the same thing
          // in the 3.x dialect and Vitest 4 removed it, so it was being read
          // by people and ignored by the runner.
          fileParallelism: false,
          hookTimeout: 30000,
          testTimeout: 30000,
        },
      },
      // Unit tests in api (Hocuspocus collab helpers — pure logic, no DB).
      {
        test: {
          name: 'api-unit',
          root: './apps/api',
          include: ['src/**/*.unit.test.ts'],
          environment: 'node',
        },
      },
      // Web UI (jsdom + React); su config trae el plugin de React.
      './apps/web/vite.config.ts',
    ],
  },
});
