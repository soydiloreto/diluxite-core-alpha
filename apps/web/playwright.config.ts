import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — E2E tests against the running stack.
 *
 * What this validates that unit/integration tests can't:
 *  - Real WebSocket connection from a browser to Hocuspocus (jsdom can't).
 *  - Two browser contexts (= two users) editing the same doc and converging.
 *  - The CSS of the read-only banner + cursors actually renders.
 *
 * What it does NOT do:
 *  - Run in CI yet (browsers need to be installed in the runner image; we
 *    do that in a follow-up). For now this is a local dev tool: `pnpm e2e`
 *    starts the stack and runs the suite.
 */

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Each test creates two contexts and a note; running them concurrently
  // against the same backend would race on note creation order.
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    actionTimeout: 5_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
