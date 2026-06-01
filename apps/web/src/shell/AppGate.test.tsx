import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppGate } from './AppGate';
import { createFakeApi } from '../fakeApi';
import { DialogProvider } from '../ui';

function renderGate(api = createFakeApi()) {
  return render(
    <DialogProvider>
      <AppGate api={api}>
        <div data-testid="shell">shell</div>
      </AppGate>
    </DialogProvider>,
  );
}

describe('AppGate', () => {
  it('renders the shell when /api/info succeeds (authenticated)', async () => {
    renderGate();
    expect(await screen.findByTestId('shell')).toBeInTheDocument();
  });

  it('renders LoginScreen when /api/info returns 401', async () => {
    const api = createFakeApi();
    vi.spyOn(api, 'info').mockRejectedValueOnce(new Error('HTTP 401'));
    renderGate(api);
    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('swaps from LoginScreen to shell after a successful login', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    // First call (mount): 401 → show login. Subsequent calls: succeed → shell.
    const spy = vi.spyOn(api, 'info').mockRejectedValueOnce(new Error('HTTP 401'));
    renderGate(api);
    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();

    // Fill the form and submit; LoginScreen calls onSuccess → AppGate re-probes
    // → spy is restored to default fakeApi behaviour, which resolves OK.
    spy.mockRestore();
    await user.type(screen.getByLabelText(/email/i), 'admin@diluxite');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByTestId('shell')).toBeInTheDocument();
    expect(screen.queryByTestId('login-screen')).not.toBeInTheDocument();
  });

  it('renders an error panel on non-401 failures (e.g. API down)', async () => {
    const api = createFakeApi();
    vi.spyOn(api, 'info').mockRejectedValueOnce(new Error('HTTP 503'));
    renderGate(api);
    expect(await screen.findByText(/Couldn't reach Diluxite/i)).toBeInTheDocument();
    expect(screen.queryByTestId('login-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });
});
