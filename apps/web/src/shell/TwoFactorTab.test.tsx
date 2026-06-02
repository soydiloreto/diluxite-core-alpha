import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TwoFactorTab } from './TwoFactorTab';
import type { ApiClient } from '../api';

/**
 * Tests del TwoFactorTab. Cubre los 3 estados visibles:
 *  - Disabled (enabled=false): muestra botón "Enable 2FA" → /enroll.
 *  - Enroll in progress: secret + QR link + input + button.
 *  - Enrolled (enabled=true): muestra el contador de backup codes + disable button.
 *  - Backup codes view tras enroll exitoso.
 *  - Error de API se muestra en role=alert.
 */

function fakeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    totpStatus: vi.fn().mockResolvedValue({ enabled: false, backupCodesRemaining: 0 }),
    totpEnroll: vi.fn().mockResolvedValue({ secret: 'SECRET12', otpauthUrl: 'otpauth://x' }),
    totpVerifyEnroll: vi
      .fn()
      .mockResolvedValue({ ok: true, backupCodes: ['aa11bb22', 'cc33dd44'] }),
    totpDisable: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as unknown as ApiClient;
}

describe('TwoFactorTab — disabled state', () => {
  it('shows enroll button when 2FA is off', async () => {
    render(<TwoFactorTab api={fakeApi()} />);
    await screen.findByTestId('twofactor-disabled');
    expect(screen.getByTestId('twofactor-start-enroll')).toBeInTheDocument();
  });

  it('clicking Enable starts the enroll flow', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-start-enroll');
    await user.click(screen.getByTestId('twofactor-start-enroll'));
    await screen.findByTestId('twofactor-enroll-form');
    expect(api.totpEnroll).toHaveBeenCalled();
    expect(screen.getByTestId('twofactor-secret')).toHaveTextContent('SECRET12');
    expect(screen.getByTestId('twofactor-otpauth-link')).toHaveTextContent('otpauth://x');
  });

  it('typing < 6 digits keeps the verify button disabled', async () => {
    const user = userEvent.setup();
    render(<TwoFactorTab api={fakeApi()} />);
    await screen.findByTestId('twofactor-start-enroll');
    await user.click(screen.getByTestId('twofactor-start-enroll'));
    await screen.findByTestId('twofactor-enroll-form');
    const input = screen.getByTestId('twofactor-enroll-code') as HTMLInputElement;
    await user.type(input, '123');
    expect(screen.getByTestId('twofactor-enroll-verify')).toBeDisabled();
  });

  it('typing 6 digits enables verify; success shows backup codes', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-start-enroll');
    await user.click(screen.getByTestId('twofactor-start-enroll'));
    await screen.findByTestId('twofactor-enroll-form');
    await user.type(screen.getByTestId('twofactor-enroll-code'), '123456');
    await user.click(screen.getByTestId('twofactor-enroll-verify'));
    const codes = await screen.findByTestId('twofactor-backup-codes');
    expect(codes).toBeInTheDocument();
    expect(api.totpVerifyEnroll).toHaveBeenCalledWith('SECRET12', '123456');
    const list = screen.getByTestId('twofactor-backup-codes-list');
    expect(list.textContent).toContain('aa11bb22');
    expect(list.textContent).toContain('cc33dd44');
  });

  it('non-numeric input is filtered out', async () => {
    const user = userEvent.setup();
    render(<TwoFactorTab api={fakeApi()} />);
    await screen.findByTestId('twofactor-start-enroll');
    await user.click(screen.getByTestId('twofactor-start-enroll'));
    await screen.findByTestId('twofactor-enroll-form');
    const input = screen.getByTestId('twofactor-enroll-code') as HTMLInputElement;
    await user.type(input, '12ab34cd56');
    expect(input.value).toBe('123456');
  });
});

describe('TwoFactorTab — enabled state', () => {
  it('shows the disable button and backup count when 2FA is on', async () => {
    const api = fakeApi({
      totpStatus: vi.fn().mockResolvedValue({ enabled: true, backupCodesRemaining: 7 }),
    });
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-enabled');
    expect(screen.getByText(/7 backup codes remaining/)).toBeInTheDocument();
    expect(screen.getByTestId('twofactor-disable')).toBeInTheDocument();
  });

  it('shows the "running low" warning when ≤3 codes left', async () => {
    const api = fakeApi({
      totpStatus: vi.fn().mockResolvedValue({ enabled: true, backupCodesRemaining: 2 }),
    });
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-enabled');
    expect(screen.getByText(/running low/i)).toBeInTheDocument();
  });

  it('disable calls api.totpDisable and refreshes status', async () => {
    const user = userEvent.setup();
    const statusFn = vi
      .fn()
      .mockResolvedValueOnce({ enabled: true, backupCodesRemaining: 5 })
      .mockResolvedValueOnce({ enabled: false, backupCodesRemaining: 0 });
    const api = fakeApi({
      totpStatus: statusFn,
      totpDisable: vi.fn().mockResolvedValue({ ok: true }),
    });
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-enabled');
    await user.click(screen.getByTestId('twofactor-disable'));
    await waitFor(() => expect(api.totpDisable).toHaveBeenCalled());
    await screen.findByTestId('twofactor-disabled');
  });
});

describe('TwoFactorTab — error paths', () => {
  it('shows error from totpStatus in role=alert', async () => {
    const api = fakeApi({
      totpStatus: vi.fn().mockRejectedValue(new Error('boom')),
    });
    render(<TwoFactorTab api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/);
  });

  it('shows error when verifyEnroll fails (wrong code)', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      totpVerifyEnroll: vi.fn().mockRejectedValue(new Error('invalid code')),
    });
    render(<TwoFactorTab api={api} />);
    await screen.findByTestId('twofactor-start-enroll');
    await user.click(screen.getByTestId('twofactor-start-enroll'));
    await screen.findByTestId('twofactor-enroll-form');
    await user.type(screen.getByTestId('twofactor-enroll-code'), '000000');
    await user.click(screen.getByTestId('twofactor-enroll-verify'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid code/);
  });
});
