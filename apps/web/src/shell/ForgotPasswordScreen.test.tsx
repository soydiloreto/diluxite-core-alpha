import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForgotPasswordScreen } from './ForgotPasswordScreen';
import { createFakeApi } from '../fakeApi';
import { DialogProvider } from '../ui';

function renderForgot(api = createFakeApi({ authMode: 'server' })) {
  render(
    <DialogProvider>
      <ForgotPasswordScreen api={api} />
    </DialogProvider>,
  );
  return api;
}

describe('ForgotPasswordScreen', () => {
  it('renders the email form initially (no "sent" view yet)', () => {
    renderForgot();
    expect(screen.getByTestId('forgot-password-screen')).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
    expect(screen.queryByTestId('forgot-sent')).not.toBeInTheDocument();
  });

  it('on submit with empty email shows an inline error, no API call', async () => {
    const user = userEvent.setup();
    const api = createFakeApi({ authMode: 'server' });
    api.forgotPassword = vi.fn();
    render(
      <DialogProvider>
        <ForgotPasswordScreen api={api} />
      </DialogProvider>,
    );

    await user.click(screen.getByRole('button', { name: /send reset link/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/email is required/i);
    expect(api.forgotPassword).not.toHaveBeenCalled();
  });

  it('on success shows the "check your email" confirmation (no enumeration leak)', async () => {
    const user = userEvent.setup();
    const api = createFakeApi({ authMode: 'server' });
    const spy = vi.fn().mockResolvedValue({ ok: true });
    api.forgotPassword = spy;
    render(
      <DialogProvider>
        <ForgotPasswordScreen api={api} />
      </DialogProvider>,
    );

    await user.type(screen.getByLabelText(/email/i), 'someone@anywhere.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(spy).toHaveBeenCalledWith('someone@anywhere.test');
    expect(await screen.findByTestId('forgot-sent')).toBeInTheDocument();
    // The confirmation echoes the email the user typed (just for UX — does NOT
    // confirm registration).
    expect(screen.getByTestId('forgot-sent').textContent).toMatch(
      /someone@anywhere\.test/,
    );
  });

  it('on real API error (rate limit / 5xx) surfaces it as an alert', async () => {
    const user = userEvent.setup();
    const api = createFakeApi({ authMode: 'server' });
    api.forgotPassword = vi.fn().mockRejectedValue(new Error('HTTP 429'));
    render(
      <DialogProvider>
        <ForgotPasswordScreen api={api} />
      </DialogProvider>,
    );

    await user.type(screen.getByLabelText(/email/i), 'x@y.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/HTTP 429/);
    // Confirmation view did NOT render.
    expect(screen.queryByTestId('forgot-sent')).not.toBeInTheDocument();
  });
});
