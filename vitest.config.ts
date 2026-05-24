import { defineConfig } from 'vitest/config';

// Tests de UNIDAD (sin base de datos): rápidos, para el loop de TDD.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
