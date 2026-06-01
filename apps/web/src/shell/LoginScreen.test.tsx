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
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('blocks submit with empty fields', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderLogin(createFakeApi(), onSuccess);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
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
    await user.click(screen.getByRole('button', { name: /sign in/i }));

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
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid credentials/i);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
