import { defineConfig } from 'vitest/config';

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
          globalSetup: ['./test/setup-integration.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
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
          globalSetup: ['./test/setup-integration.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
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
