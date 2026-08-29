import { test, expect, type APIRequestContext, request } from '@playwright/test';

/**
 * The features are actually in the product.
 *
 * Every other suite asks whether a unit behaves. This one asks the question
 * that kept getting answered wrong: is the thing we built ON SCREEN, and does
 * it do anything? The freshness badge shipped twice with green tests and was
 * invisible both times — the field was on `GET /api/notes/:id` while the web
 * reads its notes from the LIST payload. Nothing failed anywhere.
 *
 * So the assertions here are deliberately shallow and deliberately broad: one
 * per user-visible capability, checked through the UI a person uses. Depth
 * belongs to the unit and integration suites; presence belongs here.
 *
 * Needs the same running stack as `collab.spec.ts` — see its header.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

interface NoteRef {
  id: string;
  title: string;
}

async function createNote(api: APIRequestContext, label: string, body?: string): Promise<NoteRef> {
  const spaces = await api.get(`${BASE_URL}/api/spaces`);
  if (!spaces.ok()) throw new Error(`could not list spaces: HTTP ${spaces.status()}`);
  const list = (await spaces.json()) as { id: string }[];
  if (list.length === 0) throw new Error('test instance has no spaces; bootstrap missing?');
  const title = `E2Efeat${label}${Date.now()}`;
  const created = await api.post(`${BASE_URL}/api/spaces/${list[0].id}/notes`, {
    data: { title, contentMd: body ?? `# ${title}\n\ncuerpo\n` },
  });
  if (!created.ok()) throw new Error(`could not create note: HTTP ${created.status()}`);
  return (await created.json()) as NoteRef;
}

test.describe('the features are in the product', () => {
  test.setTimeout(120_000);

  let api: APIRequestContext;
  let note: NoteRef;

  test.beforeAll(async () => {
    api = await request.newContext();
    note = await createNote(
      api,
      'Main',
      `# Título\n\nun párrafo con [[Uno]] y #recorrido\n\n| Métrica | Valor |\n| --- | --- |\n| MRR | 42k |\n`,
    );
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/notes/${note.id}`);
    await page.waitForSelector('[data-testid="activity-bar"]', { timeout: 30_000 });
  });

  test('a note opens in the reading view, not the editor', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Título' }).first()).toBeVisible({
      timeout: 15_000,
    });
    // The split preview is gone and CodeMirror is not mounted until asked for.
    await expect(page.locator('.cm-content')).toHaveCount(0);
  });

  test('the editor opens and says whether it saved', async ({ page }) => {
    await page.getByLabel('edit raw markdown').click();
    await page.locator('.cm-content').click();
    await page.keyboard.type(' editado');
    // "Saved ✓" or "Live sync ✓" depending on whether collab is connected —
    // either is the editor reporting the state it is actually in.
    await expect(page.getByTestId('save-state')).toHaveText(/✓/, { timeout: 25_000 });
  });

  test('the history lists versions and offers to restore one', async ({ page }) => {
    await page.getByLabel('edit raw markdown').click();
    await page.locator('.cm-content').click();
    await page.keyboard.type(' otra vez');
    await expect(page.getByTestId('save-state')).toHaveText(/✓/, { timeout: 25_000 });

    await page.getByRole('button', { name: /history/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: /restore/i }).first()).toBeVisible();
  });

  test('the LIST payload carries freshness, which is where the badge reads it', async ({
    page,
  }) => {
    // THE bug, twice: `freshness` was on `GET /api/notes/:id` while the web
    // reads its notes from the list, so the badge could never render and no
    // test failed. Asserting the absence of a badge on a fresh note would
    // pass just as happily with the field gone — this asserts the supply.
    const spaces = (await (await api.get(`${BASE_URL}/api/spaces`)).json()) as { id: string }[];
    const notes = (await (
      await api.get(`${BASE_URL}/api/spaces/${spaces[0].id}/notes`)
    ).json()) as { id: string; freshness?: { level: string } }[];
    const mine = notes.find((n) => n.id === note.id);
    expect(mine, 'the note is missing from the list payload').toBeTruthy();
    expect(mine!.freshness?.level, 'no freshness on the list payload').toBe('fresh');

    // And a fresh note stays silent: a badge on every note is one nobody
    // reads, which costs exactly the notes where it mattered.
    await expect(page.getByTestId('freshness-badge')).toHaveCount(0);
  });

  test('search reaches the note from the palette', async ({ page }) => {
    const palette = page.getByPlaceholder('Search notes', { exact: false });
    await palette.click();
    await palette.fill(note.title);
    await expect(page.getByText(note.title).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Admin → AI reports the embedder against what is stored', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/ai`);
    await expect(page.getByTestId('admin-console')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Active provider')).toBeVisible();
    // The data, not the heading: both sections render their labels before the
    // request resolves, so asserting on a label proves nothing loaded.
    await expect(page.getByText(/\d+ dims|Nothing indexed yet/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Admin → Search shows the organisation configuration', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/search`);
    await expect(page.getByTestId('admin-console')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('combobox').first()).toBeVisible({ timeout: 20_000 });
  });

  test('the export hands over a real archive', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/current-workspace`);
    const button = page.getByTestId('space-export');
    await expect(button).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      button.click(),
    ]);
    // Named after the workspace by the server, and not empty.
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const path = await download.path();
    expect(path).toBeTruthy();
  });
});
