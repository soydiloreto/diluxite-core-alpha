import { test, expect, type Page, type BrowserContext, type APIRequestContext, request } from '@playwright/test';

/**
 * Multi-context collab smoke test.
 *
 * Two browser contexts (= two independent users with separate cookies and
 * storage) open the SAME note. Edits made in context A appear in context B
 * over the live WebSocket, and the presence avatar of A renders in B's
 * note header.
 *
 * Important: both contexts MUST open the same note id, otherwise Yjs sync
 * never happens (Y.Doc is keyed by id). Earlier versions of this spec
 * leaned on the "+ New note" UI button in each context, which always
 * created a NEW note — so A and B had different ids and the sync test
 * trivially failed even with a healthy backend. Fix: create one note via
 * the API in `beforeAll`, navigate both contexts directly to /notes/:id.
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

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

interface NoteRef {
  id: string;
  title: string;
}

/**
 * Create one shared note via the API. Returns its id so both browser contexts
 * can navigate to the same route.
 */
async function ensureSharedNote(api: APIRequestContext): Promise<NoteRef> {
  const spaces = await api.get(`${BASE_URL}/api/spaces`);
  if (!spaces.ok()) {
    throw new Error(`could not list spaces: HTTP ${spaces.status()}`);
  }
  const list = (await spaces.json()) as { id: string; name: string }[];
  if (list.length === 0) {
    throw new Error('test instance has no spaces; bootstrap missing?');
  }
  const spaceId = list[0].id;
  const title = `E2E collab note ${Date.now()}`;
  const created = await api.post(`${BASE_URL}/api/spaces/${spaceId}/notes`, {
    data: { title, contentMd: `# ${title}\n\n` },
  });
  if (!created.ok()) {
    throw new Error(`could not create note: HTTP ${created.status()}`);
  }
  const note = (await created.json()) as { id: string; title: string };
  return { id: note.id, title: note.title };
}

async function openSharedNote(page: Page, noteId: string) {
  // Direct navigation to the note route — same as a deep link.
  await page.goto(`/notes/${noteId}`);

  // Wait for the app shell. `activity-bar` always renders once the SPA boots.
  await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });

  // A note opens in the RENDERED reading view, and `CodeMirrorEditor` — which
  // is what holds the Yjs binding, the WebSocket and the presence awareness —
  // only mounts in edit mode. So a reader is deliberately NOT a collab
  // participant: no socket, no avatar. Every test in this file is about two
  // people EDITING, which means both have to take the `</>` toggle first.
  // Skipping it is why these specs timed out on `.cm-content` the moment the
  // reading view shipped.
  await page.getByLabel('edit raw markdown').click();

  // Editor mount: first Y.Doc bind + Hocuspocus connect is the slow part.
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

  let apiCtx: APIRequestContext;
  let sharedNote: NoteRef;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let a: Page;
  let b: Page;

  test.beforeAll(async () => {
    apiCtx = await request.newContext();
    sharedNote = await ensureSharedNote(apiCtx);
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

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
    await openSharedNote(a, sharedNote.id);
    await openSharedNote(b, sharedNote.id);

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
    await openSharedNote(a, sharedNote.id);
    await openSharedNote(b, sharedNote.id);

    // The chip is hidden when only `self` is connected (count === 1). With
    // two contexts we expect at least one extra avatar visible in B.
    await expect(b.getByTestId('note-presence')).toBeVisible({ timeout: 10_000 });
  });
});
