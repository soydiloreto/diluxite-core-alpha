import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiClient } from '../api';
import { renderWithCtx } from '../../test/render-with-ctx';

/**
 * SecurityTab solo coordina apertura/cierre de secciones y monta los
 * sub-componentes ya testeados (PasskeysTab / TwoFactorTab / SessionsTab,
 * cada uno con su propio test). Acá mockeamos los sub-componentes para
 * NO arrastrar sus contextos (PasskeysTab usa useApp()) — testeamos
 * únicamente el accordion behaviour.
 */

vi.mock('./PasskeysTab', () => ({
  PasskeysTab: () => <div data-testid="mock-passkeys-tab">PASSKEYS</div>,
}));
vi.mock('./TwoFactorTab', () => ({
  TwoFactorTab: () => <div data-testid="mock-twofactor-tab">TWOFACTOR</div>,
}));
vi.mock('./SessionsTab', () => ({
  SessionsTab: () => <div data-testid="mock-sessions-tab">SESSIONS</div>,
}));

// Import AFTER the mocks so the SUT picks them up.
const { SecurityTab } = await import('./SecurityTab');

function stubApi(): ApiClient {
  return {} as unknown as ApiClient;
}

describe('SecurityTab', () => {
  it('renders the 3 sections and opens passkeys by default', () => {
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'server' });
    expect(screen.getByTestId('security-section-passkeys')).toBeInTheDocument();
    expect(screen.getByTestId('security-section-twofactor')).toBeInTheDocument();
    expect(screen.getByTestId('security-section-sessions')).toBeInTheDocument();
  });

  it('renders passkeys content by default', () => {
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'server' });
    expect(screen.getByTestId('mock-passkeys-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-twofactor-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-sessions-tab')).not.toBeInTheDocument();
  });

  it('clicking 2FA toggle opens that section and closes passkeys', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'server' });
    await user.click(screen.getByTestId('security-toggle-twofactor'));
    expect(screen.getByTestId('mock-twofactor-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-passkeys-tab')).not.toBeInTheDocument();
  });

  it('clicking sessions toggle opens the sessions section', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'server' });
    await user.click(screen.getByTestId('security-toggle-sessions'));
    expect(screen.getByTestId('mock-sessions-tab')).toBeInTheDocument();
  });

  it('clicking the already-open section toggle closes it', async () => {
    const user = userEvent.setup();
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'server' });
    await user.click(screen.getByTestId('security-toggle-passkeys'));
    expect(screen.queryByTestId('mock-passkeys-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-twofactor-tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-sessions-tab')).not.toBeInTheDocument();
  });

  it('shows a lock banner in local mode (security only applies in server mode)', () => {
    renderWithCtx(<SecurityTab api={stubApi()} />, { authMode: 'local' });
    expect(screen.getByTestId('security-locked-banner')).toBeInTheDocument();
  });
});
