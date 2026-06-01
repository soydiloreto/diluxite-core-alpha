import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityBar } from './ActivityBar';
import type { ComponentProps } from 'react';

type Props = ComponentProps<typeof ActivityBar>;

/**
 * The account popover used to expose six near-identical "Settings" buttons
 * (one per modal tab). Users reported it felt cluttered and "duplicated"
 * because the modal already has the same tabs as its sidebar. The popover
 * now exposes a single "Settings" button that opens the modal without a
 * pre-selected tab; deep-links to specific tabs survive in contextual
 * surfaces (WelcomePanel, ActivityBar gear).
 *
 * These tests lock that behaviour so a refactor can't re-introduce the
 * cluttered popover by accident.
 */
describe('ActivityBar — account popover', () => {
  function renderBar(overrides: Partial<Props> = {}) {
    const props: Props = {
      active: 'explorer',
      user: { email: 'pablo@example.com' },
      workspaceLabel: 'Mi workspace',
      sidebarOpen: true,
      showAdmin: false,
      onToggleSidebar: vi.fn(),
      onHome: vi.fn(),
      onGraph: vi.fn(),
      onView: vi.fn(),
      onNew: vi.fn(),
      onAdmin: vi.fn(),
      onSettings: vi.fn(),
      onAccount: vi.fn(),
      ...overrides,
    };
    return { props, ...render(<ActivityBar {...props} />) };
  }

  it('opens a popover with a single Settings button (not one per tab)', async () => {
    const user = userEvent.setup();
    renderBar();
    const trigger = screen.getByRole('button', { name: /account|user|profile/i });
    await user.click(trigger);

    const menu = await screen.findByTestId('account-menu');
    // The current value-add of the popover is: user identity + workspace
    // shortcut + ONE Settings entry + Sign out. Anything more is creep.
    const settingsEntries = within(menu).getAllByText(/^Settings$/i);
    expect(settingsEntries).toHaveLength(1);

    // Negative assertion: the legacy tab-shortcut labels MUST be gone from
    // the popover. If a future "let's add quick access" PR re-introduces
    // them this test fails.
    expect(within(menu).queryByText(/Connect AI \(MCP\)/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/Search preferences/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/^Appearance$/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/^MCP connection$/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/^Passkeys$/i)).not.toBeInTheDocument();
    expect(within(menu).queryByText(/^About$/i)).not.toBeInTheDocument();
  });

  it('Settings button calls onSettings (no tab pre-selected)', async () => {
    const user = userEvent.setup();
    const { props } = renderBar();
    await user.click(screen.getByRole('button', { name: /account|user|profile/i }));
    await user.click(await screen.findByTestId('account-menu-settings'));
    expect(props.onSettings).toHaveBeenCalledTimes(1);
    // Crucially: onAccount (which takes a tab arg) is NOT used by the
    // generic Settings button. Tab-specific shortcuts stay alive but are
    // routed through other surfaces (Welcome, etc.).
    expect(props.onAccount).not.toHaveBeenCalled();
  });
});

