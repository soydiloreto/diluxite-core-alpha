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

    // ...then open the second from the explorer, WITHOUT reloading, so both
    // live as tabs in the same group. A `goto` rebuilds the dock from
    // scratch and would leave a single tab, which is the state this test
    // cannot use.
    await page.getByRole('button', { name: second.title }).first().click();
    await expect(secondTab).toBeVisible({ timeout: 15_000 });
    await expect(firstTab).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/notes/${second.id}$`));

    // The assertion: activating the backgrounded tab moves the route with it.
    await firstTab.click();
    await expect(page).toHaveURL(new RegExp(`/notes/${first.id}$`));
  });
});
