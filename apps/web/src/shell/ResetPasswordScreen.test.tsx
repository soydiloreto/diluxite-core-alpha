import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPasswordScreen } from './ResetPasswordScreen';
import { createFakeApi } from '../fakeApi';
import { DialogProvider } from '../ui';

function renderReset(token = 'valid-token', api = createFakeApi({ authMode: 'server' })) {
  render(
    <DialogProvider>
      <ResetPasswordScreen api={api} token={token} />
    </DialogProvider>,
  );
  return api;
}

describe('ResetPasswordScreen', () => {
  it('with empty token, shows the missing-token error + link to /forgot', () => {
    renderReset('');
    expect(screen.getByTestId('reset-missing-token')).toBeInTheDocument();
    expect(screen.queryByTestId('reset-password-screen')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /request a new reset link/i }),
    ).toHaveAttribute('href', '/forgot');
  });

  it('renders the form initially', () => {
    renderReset('any-token');
    expect(screen.getByTestId('reset-password-screen')).toBeInTheDocument();
    expect(screen.getByLabelText('new password')).toBeInTheDocument();
    expect(screen.getByLabelText('confirm new password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set new password/i })).toBeDisabled();
  });

  it('Submit is disabled until passwords match + ≥ 8 chars', async () => {
    const user = userEvent.setup();
    renderReset('any-token');
    const submit = screen.getByRole('button', { name: /set new password/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('new password'), 'short');
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText('new password'));
    await user.type(screen.getByLabelText('new password'), 'long-enough-pass');
    expect(submit).toBeDisabled(); // confirm vacío

    await user.type(screen.getByLabelText('confirm new password'), 'different');
    expect(submit).toBeDisabled();

    await user.clear(screen.getByLabelText('confirm new password'));
    await user.type(screen.getByLabelText('confirm new password'), 'long-enough-pass');
    expect(submit).not.toBeDisabled();
  });

  it('on success shows the done view + link back to sign in', async () => {
    const user = userEvent.setup();
    const api = createFakeApi({ authMode: 'server' });
    const spy = vi.fn().mockResolvedValue({ ok: true, sessionsRevoked: 2 });
    api.resetPassword = spy;
    render(
      <DialogProvider>
        <ResetPasswordScreen api={api} token="t-123" />
      </DialogProvider>,
    );

    await user.type(screen.getByLabelText('new password'), 'good-password-xyz');
    await user.type(screen.getByLabelText('confirm new password'), 'good-password-xyz');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    expect(spy).toHaveBeenCalledWith('t-123', 'good-password-xyz');
    expect(await screen.findByTestId('reset-done')).toBeInTheDocument();
    expect(screen.getByTestId('back-to-login')).toHaveAttribute('href', '/');
  });

  it('on server error (invalid/expired token) surfaces it as alert, no done view', async () => {
    const user = userEvent.setup();
    const api = createFakeApi({ authMode: 'server' });
    api.resetPassword = vi
      .fn()
      .mockRejectedValue(new Error('invalid or expired token'));
    render(
      <DialogProvider>
        <ResetPasswordScreen api={api} token="bad" />
      </DialogProvider>,
    );

    await user.type(screen.getByLabelText('new password'), 'long-enough-pass');
    await user.type(screen.getByLabelText('confirm new password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid or expired/i);
    expect(screen.queryByTestId('reset-done')).not.toBeInTheDocument();
  });
});
