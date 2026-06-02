import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from './LoginScreen';
import { createFakeApi } from '../fakeApi';
import { DialogProvider } from '../ui';
import type { ApiClient } from '../api';

function renderLogin(api: ApiClient, onSuccess: () => void) {
  return render(
    <DialogProvider>
      <LoginScreen api={api} onSuccess={onSuccess} />
    </DialogProvider>,
  );
}

describe('LoginScreen', () => {
  it('renders the email + password form', () => {
    renderLogin(createFakeApi(), () => {});
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('blocks submit with empty fields', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderLogin(createFakeApi(), onSuccess);
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/required/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('calls api.login + onSuccess on submit', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const loginSpy = vi.spyOn(api, 'login');
    const onSuccess = vi.fn();
    renderLogin(api, onSuccess);

    await user.type(screen.getByLabelText(/email/i), 'admin@diluxite.local');
    await user.type(screen.getByLabelText(/password/i), 's3cret');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(loginSpy).toHaveBeenCalledWith('admin@diluxite.local', 's3cret');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('renders an error and stays on the form when api.login throws', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    vi.spyOn(api, 'login').mockRejectedValueOnce(new Error('invalid credentials'));
    const onSuccess = vi.fn();
    renderLogin(api, onSuccess);

    await user.type(screen.getByLabelText(/email/i), 'who@diluxite');
    await user.type(screen.getByLabelText(/password/i), 'nope');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid credentials/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('LoginScreen — MFA flow', () => {
  it('switches to the MFA form when login returns requiresMfa', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    vi.spyOn(api, 'login').mockResolvedValueOnce({
      requiresMfa: true,
      mfaToken: 'tok-abc',
    } as never);
    const onSuccess = vi.fn();
    renderLogin(api, onSuccess);
    await user.type(screen.getByLabelText(/email/i), 'a@b.c');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByTestId('login-mfa-form');
    expect(onSuccess).not.toHaveBeenCalled();
    // The password form is gone.
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument();
  });

  it('submits the TOTP code to loginTotp and calls onSuccess on OK', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    vi.spyOn(api, 'login').mockResolvedValueOnce({
      requiresMfa: true,
      mfaToken: 'tok-abc',
    } as never);
    const totpSpy = vi
      .spyOn(api, 'loginTotp')
      .mockResolvedValue({ ok: true, user: { id: 'u', email: 'a@b.c' } });
    const onSuccess = vi.fn();
    renderLogin(api, onSuccess);
    await user.type(screen.getByLabelText(/email/i), 'a@b.c');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByTestId('login-mfa-form');
    await user.type(screen.getByTestId('login-mfa-input'), '123456');
    await user.click(screen.getByTestId('login-mfa-submit'));
    expect(totpSpy).toHaveBeenCalledWith('tok-abc', { code: '123456' });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('toggles to backup code mode and submits as backupCode', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    vi.spyOn(api, 'login').mockResolvedValueOnce({
      requiresMfa: true,
      mfaToken: 'tok-abc',
    } as never);
    const totpSpy = vi
      .spyOn(api, 'loginTotp')
      .mockResolvedValue({ ok: true, user: { id: 'u', email: 'a@b.c' } });
    renderLogin(api, vi.fn());
    await user.type(screen.getByLabelText(/email/i), 'a@b.c');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByTestId('login-mfa-form');
    await user.click(screen.getByTestId('login-mfa-toggle-backup'));
    // Now the input accepts hex; type a backup code.
    await user.type(screen.getByTestId('login-mfa-input'), 'abcd1234');
    await user.click(screen.getByTestId('login-mfa-submit'));
    expect(totpSpy).toHaveBeenCalledWith('tok-abc', { backupCode: 'abcd1234' });
  });

  it('shows error and stays on MFA form if loginTotp throws', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    vi.spyOn(api, 'login').mockResolvedValueOnce({
      requiresMfa: true,
      mfaToken: 'tok-abc',
    } as never);
    vi.spyOn(api, 'loginTotp').mockRejectedValueOnce(new Error('invalid code'));
    const onSuccess = vi.fn();
    renderLogin(api, onSuccess);
    await user.type(screen.getByLabelText(/email/i), 'a@b.c');
    await user.type(screen.getByLabelText(/password/i), 'pw');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
    await screen.findByTestId('login-mfa-form');
    await user.type(screen.getByTestId('login-mfa-input'), '111111');
    await user.click(screen.getByTestId('login-mfa-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid code/);
    expect(onSuccess).not.toHaveBeenCalled();
    // Still on the MFA form.
    expect(screen.getByTestId('login-mfa-form')).toBeInTheDocument();
  });
});
