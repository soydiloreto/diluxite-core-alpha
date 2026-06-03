import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * Multi-context collab smoke test.
 *
 * Two browser contexts (= two independent users with separate cookies and
 * storage) open the same note. Edits made in context A appear in context B
 * over the live WebSocket, and the presence avatar of A renders in B's
 * note header.
 *
 * Prerequisites (run BEFORE this suite):
 *  1. `docker compose up -d` — postgres + api + web reachable on default
 *     ports (5173 / 3030 / 3031). The api image has to be from the
 *     `feature/yjs-collab` branch (or later) so collab is wired up.
 *  2. The instance has `DILUXITE_AUTH_MODE=local` and a single user
 *     `local@diluxite` ready. (Server mode requires a login flow; we'll
 *     add a sibling test for it once login UI is stable.)
 *
 * Run with: `pnpm --filter @diluxite/web e2e`
 *
 * What this test does NOT cover (yet):
 *  - Disconnect/reconnect cycle (would need to stop & start the api
 *    mid-test).
 *  - Cursor-position rendering across contexts (relies on getBoundingClientRect
 *    which is flaky across headless browsers).
 *  - Right-pane preview update (covered by render-markdown unit tests).
 */

async function openFirstNote(page: Page) {
  await page.goto('/');
  // Wait for the app shell to mount. We use `activity-bar` because it's
  // ALWAYS present once the SPA boots (vs `notes-tree` which only renders
  // when there are notes — caused a false-negative timeout in the alpha.43
  // E2E run against an empty seed). 30s for CI cold-start headroom.
  await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });

  // If the test instance has no notes yet, create one. Otherwise reuse
  // whatever is at the top of the list so both contexts converge to the
  // same note id without coordinating an API call from the test.
  const newNoteButton = page.getByRole('button', { name: /new note/i }).first();
  if (await newNoteButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await newNoteButton.click();
    const input = page.getByPlaceholder(/title/i);
    if (await input.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await input.fill('E2E collab note');
      await page.getByRole('button', { name: /create/i }).click();
    }
  }
  // Editor mount waits up to 15s — the first Y.Doc bind + Hocuspocus connect
  // is the slow part. If there's still no editor, that's a real failure.
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
}

async function getEditorText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const el = document.querySelector('.cm-content');
    return (el?.textContent ?? '').replace(/ /g, ' ');
  });
}

test.describe('collab: two contexts edit the same note', () => {
  // Each test launches TWO browser contexts that go through the full
  // bootstrap (load app, mount Dockview, open a note, connect to /collab WS).
  // Default Playwright timeout is 30s which is too tight when CI is under
  // load — observed flake here in the alpha.43 deps PRs. Lift to 90s.
  test.setTimeout(90_000);

  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let a: Page;
  let b: Page;

  test.beforeEach(async ({ browser }) => {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    a = await ctxA.newPage();
    b = await ctxB.newPage();
  });

  test.afterEach(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  test('A types → B sees the same text via WebSocket sync', async () => {
    await openFirstNote(a);
    await openFirstNote(b);

    const stamp = `e2e-${Date.now()}`;
    await a.locator('.cm-content').click();
    await a.keyboard.type(`\n${stamp}`);

    // Poll until B's editor reflects the stamp from A. 10s deadline covers
    // typical loopback latency comfortably.
    await expect
      .poll(async () => getEditorText(b), {
        timeout: 10_000,
        intervals: [100, 250, 500, 1000],
      })
      .toContain(stamp);
  });

  test('presence avatars render when ≥2 contexts open the same note', async () => {
    await openFirstNote(a);
    await openFirstNote(b);

    // The chip is hidden when only `self` is connected (count === 1). With
    // two contexts we expect at least one extra avatar visible in B.
    await expect(b.getByTestId('note-presence')).toBeVisible({ timeout: 10_000 });
  });
});
