import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';
import { DialogProvider } from './ui';
import type { ApiClient } from './api';

const SPACE = 'space-1';

// jsdom doesn't implement these; Dockview + Monaco poke at them on mount.
beforeEach(() => {
  // ResizeObserver
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // scrollIntoView (cmdk pokes at it on mount)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = vi.fn();
  // matchMedia
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

describe('App v3.0 — Dockview shell + cmdk + lucide', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('renders topbar with Diluxite brand', async () => {
    renderApp(createFakeApi());
    expect(await screen.findByTestId('topbar')).toHaveTextContent('Diluxite');
  });

  it('opens settings via topbar ⚙ and URL becomes /settings', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    await user.click(
      within(await screen.findByTestId('topbar')).getByRole('button', { name: 'settings' }),
    );
    expect(await screen.findByTestId('settings-modal')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
  });

  it('switching settings tab updates the URL', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    await user.click(
      within(await screen.findByTestId('topbar')).getByRole('button', { name: 'settings' }),
    );
    const modal = await screen.findByTestId('settings-modal');
    await user.click(within(modal).getByTestId('settings-tab-appearance'));
    expect(window.location.pathname).toBe('/settings/appearance');
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
    expect(workNode).toBeInTheDocument();
    await user.click(workNode);

    await user.click(within(dock).getByRole('button', { name: 'new subfolder in Work' }));
    await fillPrompt(user, 'Projects');
    expect(await within(dock).findByText('Projects')).toBeInTheDocument();
  });

  it('command palette opens via topbar Search button', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    renderApp(api);
    await within(await screen.findByTestId('left-dock')).findAllByText('Azure');
    await user.click(within(screen.getByTestId('topbar')).getByRole('button', { name: 'Search' }));
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

  it('exposes a resize handle for the sidebar', async () => {
    renderApp(createFakeApi());
    expect(await screen.findByTestId('sidebar-resize')).toBeInTheDocument();
  });

  it('status bar MCP item is clickable and routes to /settings/mcp', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const mcp = await screen.findByRole('button', { name: /MCP/ });
    await user.click(mcp);
    expect(window.location.pathname).toBe('/settings/mcp');
  });

  it('status bar has no duplicate ⚙ (only the topbar has it)', async () => {
    renderApp(createFakeApi());
    await screen.findByTestId('topbar');
    const gears = screen.getAllByRole('button', { name: 'settings' });
    expect(gears).toHaveLength(1);
  });
});
