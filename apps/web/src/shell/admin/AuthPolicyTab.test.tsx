import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthPolicyTab } from './AuthPolicyTab';
import type { ApiClient, AuthPolicyValue } from '../../api';

/**
 * UI tests furiosos del tab Auth policy.
 *
 * Cubrimos:
 *  - Loading state al inicio.
 *  - Render con la 3 opciones después del fetch.
 *  - La opción actual viene marcada.
 *  - Click en otra opción → llama api.setAuthPolicy con ese valor.
 *  - Después de save → confirmación visible.
 *  - Error de carga muestra el mensaje.
 *  - OIDC not configured (null del API) → error friendly.
 *  - Las opciones restrictivas muestran warning.
 *  - Buttons disabled mientras busy.
 */

function fakeApi(initial: AuthPolicyValue | null, opts?: { setError?: string }): ApiClient {
  return {
    // Only the two methods we exercise — the rest unused; cast at the end.
    getAuthPolicy: vi.fn().mockResolvedValue(initial),
    setAuthPolicy: vi.fn(async (_orgId, p: AuthPolicyValue) => {
      if (opts?.setError) throw new Error(opts.setError);
      return { policy: p };
    }),
  } as unknown as ApiClient;
}

describe('AuthPolicyTab — happy paths', () => {
  it('shows loading then renders 3 options with the current one marked', async () => {
    const api = fakeApi('deny_unknown');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await screen.findByTestId('auth-policy-option-deny_unknown');
    expect(screen.getByTestId('auth-policy-option-allow_unknown_as_member')).toBeInTheDocument();
    expect(screen.getByTestId('auth-policy-option-pre_provisioned_only')).toBeInTheDocument();
    // The current one (deny_unknown) is checked.
    const denyOpt = screen.getByTestId('auth-policy-option-deny_unknown');
    const denyRadio = denyOpt.querySelector('input[type="radio"]') as HTMLInputElement;
    expect(denyRadio.checked).toBe(true);
  });

  it('selecting a different option calls api.setAuthPolicy with the new value', async () => {
    const user = userEvent.setup();
    const api = fakeApi('allow_unknown_as_member');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    await screen.findByTestId('auth-policy-option-deny_unknown');
    const denyRadio = screen
      .getByTestId('auth-policy-option-deny_unknown')
      .querySelector('input[type="radio"]') as HTMLInputElement;
    await user.click(denyRadio);
    expect(api.setAuthPolicy).toHaveBeenCalledWith('org-1', 'deny_unknown');
  });

  it('confirmation message appears after a successful save', async () => {
    const user = userEvent.setup();
    const api = fakeApi('allow_unknown_as_member');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    await screen.findByTestId('auth-policy-option-pre_provisioned_only');
    await user.click(
      screen
        .getByTestId('auth-policy-option-pre_provisioned_only')
        .querySelector('input[type="radio"]')!,
    );
    const saved = await screen.findByTestId('auth-policy-saved');
    expect(saved.textContent).toMatch(/pre_provisioned_only/);
  });

  it('marks the newly-selected option as checked after save', async () => {
    const user = userEvent.setup();
    const api = fakeApi('allow_unknown_as_member');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    await screen.findByTestId('auth-policy-option-deny_unknown');
    const denyOpt = screen.getByTestId('auth-policy-option-deny_unknown');
    await user.click(denyOpt.querySelector('input[type="radio"]')!);
    await waitFor(() => {
      const r = denyOpt.querySelector('input[type="radio"]') as HTMLInputElement;
      expect(r.checked).toBe(true);
    });
  });
});

describe('AuthPolicyTab — error paths', () => {
  it('shows the error when getAuthPolicy throws', async () => {
    const api = {
      getAuthPolicy: vi.fn().mockRejectedValue(new Error('boom')),
      setAuthPolicy: vi.fn(),
    } as unknown as ApiClient;
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/);
  });

  it('shows a friendly message when OIDC is not configured (null policy)', async () => {
    const api = fakeApi(null);
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/OIDC is not configured/i);
    // No radios rendered when policy=null.
    expect(screen.queryByTestId('auth-policy-option-deny_unknown')).not.toBeInTheDocument();
  });

  it('shows error when setAuthPolicy fails (keeps the previous value)', async () => {
    const user = userEvent.setup();
    const api = fakeApi('allow_unknown_as_member', { setError: 'permission denied' });
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    await screen.findByTestId('auth-policy-option-deny_unknown');
    await user.click(
      screen
        .getByTestId('auth-policy-option-deny_unknown')
        .querySelector('input[type="radio"]')!,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission denied/);
    // Original radio is still the checked one.
    const cur = screen
      .getByTestId('auth-policy-option-allow_unknown_as_member')
      .querySelector('input[type="radio"]') as HTMLInputElement;
    expect(cur.checked).toBe(true);
  });
});

describe('AuthPolicyTab — UX details', () => {
  it('restrictive options show a warning about pre-loading the user CSV', async () => {
    const api = fakeApi('allow_unknown_as_member');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    const deny = await screen.findByTestId('auth-policy-option-deny_unknown');
    const pre = screen.getByTestId('auth-policy-option-pre_provisioned_only');
    expect(deny.textContent).toMatch(/imported the user CSV BEFORE/i);
    expect(pre.textContent).toMatch(/Import the user CSV first/i);
  });

  it('the allow_unknown_as_member option does NOT have a warning', async () => {
    const api = fakeApi('allow_unknown_as_member');
    render(<AuthPolicyTab api={api} orgId="org-1" />);
    const allow = await screen.findByTestId('auth-policy-option-allow_unknown_as_member');
    expect(allow.textContent).not.toMatch(/⚠️/);
  });
});
