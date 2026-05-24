import { defineConfig } from 'vitest/config';

// Tests de INTEGRACIÓN (requieren Postgres + pgvector). Usan la base
// diluxite_test (ver test/setup-integration.ts). Corren en serie para
// evitar pisarse entre tests sobre la misma base.
export default defineConfig({
  test: {
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    passWithNoTests: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
