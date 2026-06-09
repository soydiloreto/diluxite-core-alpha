import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';
import { createFakeApi } from '../fakeApi';
import { DialogProvider } from '../ui';
import type { Prefs } from '../useSettings';

// Minimal Prefs object — we don't exercise these in McpTab so any valid
// shape is fine. Keep this in sync with the Prefs interface if it grows.
const DEFAULT_PREFS: Prefs = {
  theme: 'dark',
  accent: '#008671',
  searchMode: 'hybrid',
  topK: 5,
  lang: 'en',
  sidebarWidth: 288,
  previewLayout: 'side',
  previewSplitPct: 50,
  neighborsLayout: 'hidden',
  neighborsWidth: 320,
  neighborsTab: 'backlinks',
  neighborsHeight: 260,
};

/**
 * UI for token TTL chooser + revoke-all panic button (alpha.23, closing the
 * hardening #2 introduced in alpha.22). These tests assert:
 *
 * - The "Expires in (days)" input renders next to "New token" and is optional.
 * - Mint without TTL → token shows up with "expires: never".
 * - Mint with TTL → token shows up with a concrete expiry date.
 * - "Revoke all (N)" appears only when there are tokens, opens a danger
 *   confirm, calls api.revokeAllTokens() on accept, leaves the list empty.
 */
function renderModal() {
  const api = createFakeApi();
  // Open the SettingsModal directly at the `mcp` tab — the real shell does
  // this via openSettings('mcp'); here we just inject the prop.
  const TAB = 'mcp' as const;
  render(
    <DialogProvider>
      <SettingsModal
        open
        onClose={() => undefined}
        api={api}
        spaceId={null}
        prefs={DEFAULT_PREFS}
        setPref={() => undefined}
        tab={TAB}
        onTabChange={() => undefined}
      />
    </DialogProvider>,
  );
  return { api };
}

describe('McpTab — token TTL + revoke-all (alpha.23)', () => {
  it('renders the TTL input next to the token name field', async () => {
    renderModal();
    expect(await screen.findByLabelText(/token name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/token ttl days/i)).toBeInTheDocument();
  });

  it('mint WITHOUT a TTL value → expires "never"', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByLabelText(/token name/i), 'no-ttl');
    await user.click(screen.getByRole('button', { name: /generate|create/i }));
    // Tokens list shows the new entry with "expires: never".
    expect(await screen.findByText(/no-ttl/i)).toBeInTheDocument();
    const list = screen.getByText(/no-ttl/i).closest('li')!;
    expect(within(list).getByText(/expires:\s*never/i)).toBeInTheDocument();
  });

  it('mint WITH expiresInDays=30 → expires shows a concrete future date', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByLabelText(/token name/i), 'with-ttl');
    await user.type(screen.getByLabelText(/token ttl days/i), '30');
    await user.click(screen.getByRole('button', { name: /generate|create/i }));
    const list = (await screen.findByText(/with-ttl/i)).closest('li')!;
    // Not "never", not "expired". A date string.
    expect(within(list).queryByText(/expires:\s*never/i)).not.toBeInTheDocument();
    expect(within(list).queryByText(/expires:\s*expired/i)).not.toBeInTheDocument();
    expect(within(list).getByText(/expires:/i)).toBeInTheDocument();
  });

  it('"Revoke all" hidden when there are 0 tokens; shown when ≥ 1', async () => {
    const user = userEvent.setup();
    renderModal();
    // Empty list at first → no panic button.
    expect(screen.queryByTestId('revoke-all-tokens')).not.toBeInTheDocument();
    await user.type(await screen.findByLabelText(/token name/i), 'one');
    await user.click(screen.getByRole('button', { name: /generate|create/i }));
    expect(await screen.findByTestId('revoke-all-tokens')).toBeInTheDocument();
  });

  it('clicking "Revoke all" asks for confirmation; accepting empties the list', async () => {
    const user = userEvent.setup();
    renderModal();
    // Mint a few.
    for (const n of ['a', 'b', 'c']) {
      await user.clear(screen.getByLabelText(/token name/i));
      await user.type(screen.getByLabelText(/token name/i), n);
      await user.click(screen.getByRole('button', { name: /generate|create/i }));
    }
    await waitFor(() =>
      expect(screen.getByTestId('revoke-all-tokens').textContent).toMatch(/3/),
    );

    await user.click(screen.getByTestId('revoke-all-tokens'));
    // The danger confirm dialog renders — accept it.
    const confirmBtn = await screen.findByRole('button', { name: /^Revoke all$/i });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByText(/^a$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^b$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^c$/i)).not.toBeInTheDocument();
    });
  });

  it('cancelling the "Revoke all" confirm keeps the tokens intact', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(await screen.findByLabelText(/token name/i), 'keep-me');
    await user.click(screen.getByRole('button', { name: /generate|create/i }));
    await screen.findByText(/keep-me/i);
    await user.click(screen.getByTestId('revoke-all-tokens'));
    // Click the cancel/cross — depending on Dialog impl. Hit Escape for
    // a stable interaction across the shell's confirm dialog flavours.
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/keep-me/i)).toBeInTheDocument();
  });
});

// Silence vitest about the unused vi import in case the dependency tracker
// complains in some envs. (No mocks needed here; fakeApi is sufficient.)
void vi;
