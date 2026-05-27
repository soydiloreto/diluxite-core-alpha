import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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
    expect(within(bar).getByRole('button', { name: 'settings' })).toBeInTheDocument();
  });

  it('opens settings via activity bar ⚙ and URL becomes /settings', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    await user.click(
      within(await screen.findByTestId('activity-bar')).getByRole('button', { name: 'settings' }),
    );
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

  it('command palette opens via activity bar Search', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    renderApp(api);
    await within(await screen.findByTestId('left-dock')).findAllByText('Azure');
    await user.click(
      within(await screen.findByTestId('activity-bar')).getByRole('button', { name: 'search' }),
    );
    expect(await screen.findByTestId('quick-switcher')).toBeInTheDocument();
  });

  it('bulk delete with confirm dialog', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'A', 'x');
    await api.createNote(SPACE, 'B', 'y');
    renderApp(api);
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'select A' }));
    await user.click(within(dock).getByRole('button', { name: 'select B' }));
    await user.click(within(dock).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByTestId('confirm-dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(within(screen.getByTestId('left-dock')).queryByText('A')).toBeNull();
      expect(within(screen.getByTestId('left-dock')).queryByText('B')).toBeNull();
    });
  });

  it('deeplink: /settings/mcp opens that tab', async () => {
    window.history.replaceState(null, '', '/settings/mcp');
    renderApp(createFakeApi());
    const modal = await screen.findByTestId('settings-modal');
    expect(within(modal).getByTestId('mcp-url')).toBeInTheDocument();
  });

  it('status bar MCP item routes to /settings/mcp', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const mcp = await screen.findByRole('button', { name: /MCP/ });
    await user.click(mcp);
    expect(window.location.pathname).toBe('/settings/mcp');
  });

  it('Explorer toggles the sidebar', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const bar = await screen.findByTestId('activity-bar');
    expect(screen.getByTestId('left-dock')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'explorer' }));
    await waitFor(() => expect(screen.queryByTestId('left-dock')).toBeNull());
    await user.click(within(bar).getByRole('button', { name: 'explorer' }));
    await waitFor(() => expect(screen.getByTestId('left-dock')).toBeInTheDocument());
  });
});
