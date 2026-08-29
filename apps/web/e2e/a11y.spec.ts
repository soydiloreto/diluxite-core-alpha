import { test, expect, type APIRequestContext, type Page, request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * WCAG 2.1 AA, measured in a real browser.
 *
 * There are jsdom-based axe checks in the unit suite, and they are worth
 * having, but jsdom has no layout and no styles: it structurally cannot see
 * colour contrast, focus order, or an overlay covering a control — which is
 * most of what AA is about. Only this file can. Two violations that every
 * jsdom check passed clean were found here:
 *
 *  - `aria-valid-attr-value` (critical): the command palette input carried
 *    `aria-controls` pointing at a list that was only rendered while open.
 *  - `nested-interactive` (serious): dockview's default tab puts a real
 *    `<button>` inside an element that is itself `role="tab"` + `tabindex=0`.
 *
 * Both are fixed; this suite is what keeps them fixed. Accessibility fails
 * silently — nothing throws, no pixel moves, and the only signal is a person
 * who cannot use the product — so the check has to be automatic.
 *
 * Coverage is by STATE, not by page: this is a single-page app whose
 * accessibility tree changes completely when a modal, a palette or an editor
 * opens, and a violation introduced in a dialog is invisible to a scan of the
 * screen behind it.
 *
 * Needs the same running stack as `collab.spec.ts` — see its header.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

/** The WCAG 2.1 AA conformance set, and nothing beyond it. */
const WCAG_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function createNote(api: APIRequestContext, label: string): Promise<{ id: string; title: string }> {
  const spaces = await api.get(`${BASE_URL}/api/spaces`);
  if (!spaces.ok()) throw new Error(`could not list spaces: HTTP ${spaces.status()}`);
  const list = (await spaces.json()) as { id: string }[];
  if (list.length === 0) throw new Error('test instance has no spaces; bootstrap missing?');
  const title = `E2Ea11y${label}${Date.now()}`;
  const created = await api.post(`${BASE_URL}/api/spaces/${list[0].id}/notes`, {
    data: {
      title,
      // A table and a link so the fact lane, the freshness note and the
      // rendered-markdown styles all take part in the contrast measurement.
      contentMd: `# ${title}\n\nun párrafo con un [enlace](https://example.org).\n\n| Métrica | Valor |\n| --- | --- |\n| MRR | 42k |\n`,
    },
  });
  if (!created.ok()) throw new Error(`could not create note: HTTP ${created.status()}`);
  return (await created.json()) as { id: string; title: string };
}

/**
 * Run axe and fail with the actual rule, element and reason.
 *
 * Playwright's default diff on an array of violation objects is unreadable,
 * and an a11y failure is only actionable if you can see WHICH node broke
 * WHICH rule without re-running anything.
 */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  const report = violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id} — ${v.help}\n` +
        v.nodes
          .slice(0, 5)
          .map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`)
          .join('\n'),
    )
    .join('\n');
  expect(report, `WCAG 2.1 AA violations in state: ${state}`).toBe('');
}

test.describe('WCAG 2.1 AA', () => {
  test.setTimeout(120_000);

  let apiCtx: APIRequestContext;
  let note: { id: string; title: string };

  test.beforeAll(async () => {
    apiCtx = await request.newContext();
    note = await createNote(apiCtx, 'Note');
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/notes/${note.id}`);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });
    await expect(page.locator('.dv-tab', { hasText: note.title }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('the shell with a note open', async ({ page }) => {
    await expectNoViolations(page, 'note open (reading view)');
  });

  test('the raw markdown editor', async ({ page }) => {
    await page.getByLabel('edit raw markdown').click();
    await page.waitForSelector('.cm-content', { timeout: 15_000 });
    await expectNoViolations(page, 'raw editor');
  });

  test('the command palette', async ({ page }) => {
    // The palette is the state that produced the critical violation: its
    // input advertises `aria-controls` at all times.
    const palette = page.getByPlaceholder('Search notes', { exact: false });
    await palette.click();
    await palette.fill('E2E');
    await expectNoViolations(page, 'command palette open');
  });

  test('the settings dialog', async ({ page }) => {
    // Settings lives behind the account popover, so this scan covers the
    // popover's own tree on the way in as well.
    await page.getByLabel('account').click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });
    await expectNoViolations(page, 'settings dialog');
  });

  test('every activity-bar view', async ({ page }) => {
    // Explorer, search, favorites, recent, trash — each swaps the whole
    // sidebar for a different tree, and a scan of one says nothing about the
    // others. The accessible names are the activity bar's `aria-label`s.
    // `button` is the activity bar's `aria-label`, `shows` a marker that only
    // appears once that view has actually rendered. Both are asserted rather
    // than skipped: a renamed label would otherwise quietly reduce this test
    // to scanning nothing while still reporting green.
    const views = [
      { button: 'search', shows: 'Search' },
      { button: 'favorites', shows: 'Favorites' },
      { button: 'recent', shows: 'Timeline' },
      { button: 'trash', shows: 'Trash' },
    ];
    for (const view of views) {
      const button = page.getByLabel(view.button, { exact: true });
      await expect(button, `no activity-bar button labelled "${view.button}"`).toBeVisible();
      await button.click();
      await expect(page.getByText(view.shows, { exact: true }).first()).toBeVisible();
      await expectNoViolations(page, `activity bar: ${view.button}`);
    }

    // Back to the explorer, which is the sidebar people actually live in.
    await page.getByLabel('explorer', { exact: true }).click();
    await expect(page.getByLabel('new folder')).toBeVisible();
    await expectNoViolations(page, 'activity bar: explorer');
  });
});

/**
 * The keyboard path that has to survive removing dockview's nested close
 * button.
 *
 * Deleting the `<button>` fixed the axe violation and would have silently
 * removed the ability to close a tab without a mouse if nothing had taken
 * its place — a strictly worse outcome for exactly the people the fix was
 * for. Dockview's tab strip implements the WAI-ARIA deletable-tabs pattern
 * itself (Delete / Backspace, roving focus to the neighbour), so nothing
 * needed writing; this is what proves the ✕ was the only thing removed.
 *
 * Writing it also uncovered a collision that predates all of this: the
 * explorer binds Delete document-wide to delete the selected note, so with a
 * note selected there, Delete on its tab closed the tab AND popped
 * "Delete 1 item?" behind it. See the third test.
 */
test.describe('closing a tab', () => {
  test.setTimeout(90_000);

  let apiCtx: APIRequestContext;
  let note: { id: string; title: string };

  test.beforeAll(async () => {
    apiCtx = await request.newContext();
    note = await createNote(apiCtx, 'Close');
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test('Delete on the focused tab closes it, and the ✕ still does too', async ({ page }) => {
    await page.goto(`${BASE_URL}/notes/${note.id}`);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });

    const tab = page.locator('.dv-tab', { hasText: note.title }).first();
    await expect(tab).toBeVisible({ timeout: 15_000 });

    await tab.focus();
    await page.keyboard.press('Delete');
    await expect(page.locator('.dv-tab', { hasText: note.title })).toHaveCount(0, { timeout: 10_000 });

    // The tab CLOSED — the note is still there. Not a pedantic distinction:
    // NotesTree binds the same key document-wide to delete the selected note,
    // and opening a note selects it, so the first version of this test went
    // green with the tab handler disabled because the note itself had been
    // deleted out from under it.
    const still = await apiCtx.get(`${BASE_URL}/api/notes/${note.id}`);
    expect(still.status(), 'Delete on a tab must not delete the note').toBe(200);

    // And the pointer affordance, which is decorative for assistive tech but
    // is how everyone else closes a tab.
    await page.goto(`${BASE_URL}/notes/${note.id}`);
    const reopened = page.locator('.dv-tab', { hasText: note.title }).first();
    await expect(reopened).toBeVisible({ timeout: 15_000 });
    await reopened.locator('.dv-default-tab-action').click();
    await expect(page.locator('.dv-tab', { hasText: note.title })).toHaveCount(0, { timeout: 10_000 });
  });

  test('closing a tab does not offer to delete the note selected in the explorer', async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/notes/${note.id}`);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });

    // Select it in the explorer — a plain click, which is how anyone gets
    // there. The selection then outlives the click.
    await page.getByRole('button', { name: note.title }).first().click();
    const tab = page.locator('.dv-tab', { hasText: note.title }).first();
    await expect(tab).toBeVisible({ timeout: 15_000 });

    await tab.focus();
    await page.keyboard.press('Delete');

    await expect(page.locator('.dv-tab', { hasText: note.title })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // And the explorer's own Delete still works, which is the half a
    // focus rule is easy to break.
    await page.getByRole('button', { name: note.title }).first().click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
  });
});
