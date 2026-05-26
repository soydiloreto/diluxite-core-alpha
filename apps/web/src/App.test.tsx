import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { createFakeApi } from './fakeApi';
import { DialogProvider } from './ui';
import type { ApiClient } from './api';

const SPACE = 'space-1';

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

describe('App v2.1 — topbar + dialogs + URL routing', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('shows topbar with Diluxite brand and empty state', async () => {
    renderApp(createFakeApi());
    expect(await screen.findByTestId('topbar')).toHaveTextContent('Diluxite');
    expect(await screen.findByText(/Your memory is waiting/)).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'My note', level: 2 })).toBeInTheDocument();
    expect(window.location.pathname).toMatch(/^\/notes\//);
  });

  it('creates a folder and a subfolder inside it', async () => {
    const user = userEvent.setup();
    renderApp(createFakeApi());
    const dock = await screen.findByTestId('left-dock');

    await user.click(within(dock).getByRole('button', { name: 'new folder' }));
    await fillPrompt(user, 'Work');
    const workNode = await within(dock).findByText('Work');
    expect(workNode).toBeInTheDocument();
    // Expand 'Work' so the subfolder we're about to create is visible.
    await user.click(workNode);

    await user.click(within(dock).getByRole('button', { name: 'new subfolder in Work' }));
    await fillPrompt(user, 'Projects');
    expect(await within(dock).findByText('Projects')).toBeInTheDocument();
  });

  it('close-note button (✕) returns to /', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'N', 'x');
    renderApp(api);
    await user.click(await screen.findByText('N'));
    expect(window.location.pathname).toMatch(/^\/notes\//);
    await user.click(screen.getByRole('button', { name: 'close note' }));
    expect(window.location.pathname).toBe('/');
  });

  it('quick switcher opens via topbar Search button', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'Azure', 'la nube');
    renderApp(api);
    await screen.findByText('Azure');
    await user.click(within(screen.getByTestId('topbar')).getByRole('button', { name: /Search/ }));
    expect(await screen.findByTestId('quick-switcher')).toBeInTheDocument();
  });

  it('favorite toggle changes aria-label', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'F', 'x');
    renderApp(api);
    await user.click(await screen.findByText('F'));
    await user.click(screen.getByRole('button', { name: 'favorite' }));
    expect(await screen.findByRole('button', { name: 'unfavorite' })).toBeInTheDocument();
  });

  it('bulk delete with confirm dialog', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    await api.createNote(SPACE, 'A', 'x');
    await api.createNote(SPACE, 'B', 'y');
    renderApp(api);
    const dock = await screen.findByTestId('left-dock');
    await user.click(within(dock).getByRole('button', { name: 'marcar A' }));
    await user.click(within(dock).getByRole('button', { name: 'marcar B' }));
    await user.click(within(dock).getByRole('button', { name: 'Borrar' }));
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
});
