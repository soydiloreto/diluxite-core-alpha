import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';
import { DialogProvider } from './ui';
import type { ApiClient } from './api';

const SPACE = 'space-1';

// jsdom doesn't implement these; Dockview + Monaco + cmdk poke at them on mount.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = vi.fn();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderApp(api: ApiClient) {
  return render(
    <DialogProvider>
      <App api={api} />
    </DialogProvider>,
  );
}

async function fillPrompt(user: ReturnType<typeof userEvent.setup>, text: string, ok = 'Create') {
  const dlg = await screen.findByTestId('prompt-dialog');
  await user.type(within(dlg).getByLabelText('dialog input'), text);
  await user.click(within(dlg).getByRole('button', { name: ok }));
}

describe('App v3.1 — Activity Bar + Dockview + cmdk', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('renders activity bar with brand + account icons', async () => {
    renderApp(createFakeApi());
    const bar = await screen.findByTestId('activity-bar');
    expect(within(bar).getByRole('button', { name: 'home' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'account' })).toBeInTheDocument();
    // Settings was moved into the account popover in v4.x — no longer a
    // top-level button on the activity bar.
  });

  it('opens settings via the account popover and URL becomes /settings', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const bar = await screen.findByTestId('activity-bar');
    await user.click(within(bar).getByRole('button', { name: 'account' }));
    const menu = await screen.findByTestId('account-menu');
    // alpha.19 collapsed the six per-tab shortcuts into a single "Settings"
    // entry — the modal opens without a pre-selected tab.
    await user.click(within(menu).getByTestId('account-menu-settings'));
    expect(await screen.findByTestId('settings-modal')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
  });

  it('account button opens a popover with the user email', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const bar = await screen.findByTestId('activity-bar');
    await user.click(within(bar).getByRole('button', { name: 'account' }));
    const menu = await screen.findByTestId('account-menu');
    expect(menu).toHaveTextContent(/local single-user mode/i);
  });

  it('creates a note via in-app dialog and routes to /notes/:id', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'new note' }));
    await fillPrompt(user, 'My note');
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/notes\//));
  });

  it('creates a folder and a subfolder inside it', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');

    await user.click(within(dock).getByRole('button', { name: 'new folder' }));
    await fillPrompt(user, 'Work');
    const workNode = await within(dock).findByText('Work');
    await user.click(workNode);

    await user.click(within(dock).getByRole('button', { name: 'new subfolder in Work' }));
    await fillPrompt(user, 'Projects');
    expect(await within(dock).findByText('Projects')).toBeInTheDocument();
  });

  it('deeplink: /settings/mcp opens that tab', async () => {
    window.history.replaceState(null, '', '/settings/mcp');
    renderApp(createFakeApi());
    const modal = await screen.findByTestId('settings-modal');
    expect(within(modal).getByTestId('mcp-url')).toBeInTheDocument();
  });

  it('deeplink: /trash opens the Trash view (regression: was stuck on Explorer)', async () => {
    window.history.replaceState(null, '', '/trash');
    renderApp(createFakeApi());
    // The route→sidebarView sync used to omit 'trash', so a direct URL load
    // never switched away from the Explorer. The empty-trash copy proves we did.
    expect(await screen.findByText(/Trash is empty|recovery/i)).toBeInTheDocument();
  });

  it('Cmd+F opens the in-app Search view instead of the browser find bar', async () => {
    renderApp(createFakeApi());
    await screen.findByTestId('activity-bar');

    const ev = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    act(() => {
      document.dispatchEvent(ev);
    });

    // preventDefault is what actually keeps the browser's find bar shut.
    expect(ev.defaultPrevented).toBe(true);
    const box = await screen.findByLabelText('search query');
    expect(window.location.pathname).toBe('/search');
    await waitFor(() => expect(document.activeElement).toBe(box));
  });

  it('status bar MCP item routes to /settings/mcp', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    // Scope to the status bar — the Welcome panel also mentions "MCP" in the
    // Quick Actions card which would otherwise match.
    const statusBar = await screen.findByRole('contentinfo').catch(() => null);
    const root = statusBar ?? document.body;
    const mcp = await within(root).findByRole('button', { name: /^MCP$/ });
    await user.click(mcp);
    expect(window.location.pathname).toBe('/settings/mcp');
  });

  it('Explorer opens the tree, and clicking it again does not hide the notes', async () => {
    // It used to toggle: a second click closed the panel and the notes
    // disappeared, which reads as losing them rather than as tidying up.
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const bar = await screen.findByTestId('activity-bar');
    expect(screen.getByTestId('left-dock')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'explorer' }));
    await waitFor(() => expect(screen.getByTestId('left-dock')).toBeInTheDocument());
    await user.click(within(bar).getByRole('button', { name: 'explorer' }));
    expect(screen.getByTestId('left-dock')).toBeInTheDocument();
  });

  it('backlinks fetch failure clears the loading state (no eternal "Loading…")', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    api.backlinks = () => Promise.reject(new Error('HTTP 500'));
    renderApp(api);
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'new note' }));
    await fillPrompt(user, 'Lonely note');
    // Open the Neighbors footer — default tab is "backlinks".
    await user.click(await screen.findByRole('button', { name: 'show neighbors' }));
    // Without the .catch the rejected promise left `loading.backlinks` stuck
    // on true and this stayed "Loading…" forever.
    expect(await screen.findByText(/No notes link here yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument();
  });

  it('navigating to /admin and back preserves open note tabs (dock is never unmounted)', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'new note' }));
    await fillPrompt(user, 'Persisted note');
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/notes\//));

    // Go to the admin console.
    const bar = await screen.findByTestId('activity-bar');
    await user.click(within(bar).getByRole('button', { name: 'admin' }));
    await waitFor(() => expect(window.location.pathname).toBe('/admin'));

    // Come back home. With the old conditional render this remounted Dockview
    // and lost every tab; with the overlay the dock kept its tabs.
    await user.click(within(bar).getByRole('button', { name: 'home' }));
    await waitFor(() => expect(window.location.pathname).toBe('/'));

    // The note tab is still in the dock (its title persists as a tab header).
    const main = await screen.findByTestId('main');
    await waitFor(() =>
      expect(within(main).getByText('Persisted note')).toBeInTheDocument(),
    );
  });

  it('diluxite:new-note creates in the current note\'s folder (no stale-closure → wrong folder)', async () => {
    // Regression: the global `diluxite:new-note` listener only re-subscribed on
    // spaceId change, capturing `notes`/`currentNoteId` from the first render
    // (empty / null). A note created via the event then landed at root instead
    // of next to the note the user was reading. We now call createNote through
    // a ref refreshed every render, so it sees fresh state.
    const user = userEvent.setup();
    const api = createFakeApi();
    const createSpy = vi.spyOn(api, 'createNote');
    renderApp(api);
    const dock = await screen.findByTestId('left-dock');

    // Make a folder and a note inside it; the note opens and becomes current.
    await user.click(within(dock).getByRole('button', { name: 'new folder' }));
    await fillPrompt(user, 'Work');
    const workNode = await within(dock).findByText('Work');
    await user.click(workNode);
    await user.click(within(dock).getByRole('button', { name: 'new note in Work' }));
    await fillPrompt(user, 'In folder note');
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/notes\//));

    // The folderId the in-folder note got created with.
    const inFolderCall = createSpy.mock.calls.find((c) => c[1] === 'In folder note');
    const folderId = inFolderCall?.[3];
    expect(folderId).toBeTruthy();
    createSpy.mockClear();

    // Now fire the global event (what WelcomePanel's "New note" dispatches).
    //
    // Inside `act`, and that is the actual fix rather than a longer wait: the
    // listener opens a dialog, so dispatching updates React state from outside
    // React's own event handling. Unwrapped, that update is flushed whenever
    // the scheduler gets to it — which is deterministic on an idle machine and
    // a race inside the full suite. React says so in the warning it prints.
    act(() => {
      window.dispatchEvent(new Event('diluxite:new-note'));
    });
    await screen.findByTestId('prompt-dialog');
    await fillPrompt(user, 'From event');
    await waitFor(() =>
      expect(createSpy.mock.calls.some((c) => c[1] === 'From event')).toBe(true),
    );
    const eventCall = createSpy.mock.calls.find((c) => c[1] === 'From event');
    // Must inherit the current note's folder, not default to root (null).
    expect(eventCall?.[3]).toBe(folderId);
  });

  it('middle-click on a note tab closes exactly that panel (resolved by id, not title)', async () => {
    // Regression: middle-click resolved the panel by tab *title*; note titles
    // aren't unique, so clicking a tab could close a different homonymous one.
    // We now resolve by the dockview panel id stamped on the tab as
    // `data-panel-id`. We assert middle-click on the active note's tab closes
    // that exact panel (jsdom's dockview replaces transient preview tabs, so a
    // two-homonyms scenario isn't reproducible here — but the id-based
    // resolution is what this exercises).
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'new note' }));
    await fillPrompt(user, 'Closeme');
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/notes\//));

    const tab = await waitFor(() => {
      const el = document.querySelector('[data-panel-id^="note:"]');
      if (!el) throw new Error('note tab not rendered yet');
      return el as HTMLElement;
    });
    const panelId = tab.getAttribute('data-panel-id')!;
    fireEvent.mouseDown(tab, { button: 1 });
    await waitFor(() =>
      expect(document.querySelector(`[data-panel-id="${panelId}"]`)).toBeNull(),
    );
  });

  it('delete-note confirm says the note goes to Trash, not "permanently deleted"', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'new note' }));
    await fillPrompt(user, 'Doomed note');
    await user.click(await screen.findByRole('button', { name: 'delete note' }));
    const dlg = await screen.findByTestId('confirm-dialog');
    // Server soft-deletes to Trash (restorable) — the copy must say so.
    expect(within(dlg).getByText(/moved to Trash/i)).toBeInTheDocument();
    expect(within(dlg).queryByText(/permanently/i)).not.toBeInTheDocument();
  });
});
