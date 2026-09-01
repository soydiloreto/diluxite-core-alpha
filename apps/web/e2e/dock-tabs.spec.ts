import { test, expect, type APIRequestContext, request } from '@playwright/test';

/**
 * Dockview tab activation must drive the route.
 *
 * Clicking a tab header is one of the two ways the active note changes (the
 * other is the explorer), and the URL is what the explorer highlight, the
 * outline and every deep link read. When that link breaks, nothing throws:
 * the editor swaps panes, the address bar keeps pointing at the previous
 * note, and the explorer goes on highlighting a row you are no longer
 * looking at.
 *
 * It broke exactly that way on the dockview 6 → 8 upgrade:
 * `onDidActivePanelChange` went from handing over the panel to handing over
 * `{ panel, origin }`, so `panel.id` read `undefined` and the handler bailed
 * on every activation. TypeScript caught that particular shape change; a
 * future one that stays type-compatible would not, which is what this test
 * is for.
 *
 * Needs the same running stack as `collab.spec.ts` — see its header.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

interface NoteRef {
  id: string;
  title: string;
}

/**
 * Titles are prefixed and timestamped so they stay unique against notes left
 * behind by earlier runs — the explorer lookup below is by accessible name,
 * and a repeated title would make it ambiguous.
 */
async function createNote(api: APIRequestContext, label: string): Promise<NoteRef> {
  const spaces = await api.get(`${BASE_URL}/api/spaces`);
  if (!spaces.ok()) throw new Error(`could not list spaces: HTTP ${spaces.status()}`);
  const list = (await spaces.json()) as { id: string }[];
  if (list.length === 0) throw new Error('test instance has no spaces; bootstrap missing?');
  const title = `E2Etab${label}${Date.now()}`;
  const created = await api.post(`${BASE_URL}/api/spaces/${list[0].id}/notes`, {
    data: { title, contentMd: `# ${title}\n\ncuerpo\n` },
  });
  if (!created.ok()) throw new Error(`could not create note: HTTP ${created.status()}`);
  const note = (await created.json()) as NoteRef;
  return { id: note.id, title: note.title };
}

test.describe('dockview: activating a tab drives the route', () => {
  test.setTimeout(90_000);

  let apiCtx: APIRequestContext;
  let first: NoteRef;
  let second: NoteRef;

  test.beforeAll(async () => {
    apiCtx = await request.newContext();
    first = await createNote(apiCtx, 'First');
    second = await createNote(apiCtx, 'Second');
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test('clicking a background tab navigates to that note', async ({ page }) => {
    // Land on the first note with a real page load...
    await page.goto(`${BASE_URL}/notes/${first.id}`);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });

    const firstTab = page.locator('.dv-tab', { hasText: first.title }).first();
    const secondTab = page.locator('.dv-tab', { hasText: second.title }).first();
    await expect(firstTab).toBeVisible({ timeout: 15_000 });

    // PIN the first tab by typing in it. A note you only looked at is the
    // throwaway "preview" tab (VS Code's rule, `previewId` in App.tsx) and
    // opening another note EVICTS it — so without this the test races the
    // eviction and only sometimes ends up with two tabs. It passed locally
    // and failed in CI for exactly that reason. Editing is also what a person
    // does before a tab is worth keeping.
    await page.getByLabel('edit raw markdown').click();
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');

    // Wait for the autosave to LAND, not just to be pending. Typing arms a
    // ~4s timer, and letting it fire in the middle of the tab assertions below
    // is what made this test flaky: the save resolves, the panel re-renders,
    // and the click that was already in flight goes nowhere. Waiting for the
    // settled state drains the timer before the part we actually measure.
    await expect(page.getByTestId('save-state')).toHaveText(/✓/, { timeout: 15_000 });

    // ...then open the second from the explorer, WITHOUT reloading, so both
    // live as tabs in the same group. A `goto` rebuilds the dock from scratch
    // and would leave a single tab, which is the state this test cannot use.
    await page.getByRole('button', { name: second.title }).first().click();
    await expect(secondTab).toBeVisible({ timeout: 15_000 });
    await expect(firstTab).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/notes/${second.id}$`));

    // The assertion: activating the backgrounded tab moves the route with it.
    //
    // Retried as a unit, because the CLICK is the flaky half, not the
    // navigation. The tab strip re-lays out after the note that just opened
    // finishes rendering, and a click that lands mid-layout is swallowed by
    // dockview — twice in CI, on PRs that touched neither tabs nor routing,
    // always as "the URL is still the other note". What the test is about is
    // whether activating a background tab moves the route; whether the first
    // click of the two lands is not the product behaviour under test, and a
    // person whose click did nothing clicks again.
    await expect(async () => {
      await firstTab.click();
      await expect(page).toHaveURL(new RegExp(`/notes/${first.id}$`), { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  });
});
