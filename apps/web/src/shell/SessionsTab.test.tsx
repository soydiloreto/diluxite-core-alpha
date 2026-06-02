import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionsTab } from './SessionsTab';
import type { ApiClient } from '../api';

/**
 * Tests del SessionsTab. Cubrimos:
 *  - Loading → tabla con rows.
 *  - Empty state cuando no hay sessions.
 *  - El row con current:true se marca y NO muestra el botón Revoke.
 *  - Click en Revoke llama api.revokeSession(id) + refresh.
 *  - "Sign out others" llama api.revokeOtherSessions + refresh.
 *  - "Sign out others" NO se renderiza cuando no hay otras sesiones (todas current).
 *  - Error de API se muestra en role=alert.
 *  - Detail de device (user_agent) + IP se muestra.
 */

function makeSession(over: Partial<Parameters<ApiClient['listActiveSessions']>[0]> | undefined = undefined) {
  const base = {
    id: 's1',
    createdAt: new Date('2026-06-01T10:00:00Z').toISOString(),
    lastSeenAt: new Date('2026-06-02T10:00:00Z').toISOString(),
    expiresAt: new Date('2026-07-01T10:00:00Z').toISOString(),
    ip: '203.0.113.10',
    userAgent: 'Mozilla/5.0 Chrome/120',
    current: false,
  };
  return { ...base, ...over } as Awaited<ReturnType<ApiClient['listActiveSessions']>>['sessions'][number];
}

function fakeApi(initial: ReturnType<typeof makeSession>[] = []): ApiClient {
  return {
    listActiveSessions: vi.fn().mockResolvedValue({ sessions: initial }),
    revokeSession: vi.fn().mockResolvedValue({ ok: true }),
    revokeOtherSessions: vi.fn().mockResolvedValue({ revoked: 0 }),
  } as unknown as ApiClient;
}

describe('SessionsTab — happy paths', () => {
  it('renders a table with the active sessions', async () => {
    render(
      <SessionsTab
        api={fakeApi([
          { ...makeSession({ id: 's1', userAgent: 'Chrome' }) },
          { ...makeSession({ id: 's2', userAgent: 'Firefox' }) },
        ])}
      />,
    );
    await screen.findByTestId('sessions-table');
    expect(screen.getByTestId('sessions-row-s1')).toBeInTheDocument();
    expect(screen.getByTestId('sessions-row-s2')).toBeInTheDocument();
  });

  it('marks the current session and hides its Revoke button', async () => {
    render(
      <SessionsTab
        api={fakeApi([
          { ...makeSession({ id: 's1', current: true }) },
          { ...makeSession({ id: 's2', current: false }) },
        ])}
      />,
    );
    await screen.findByTestId('sessions-table');
    expect(screen.getByTestId('sessions-current-marker')).toBeInTheDocument();
    // Revoke button only on non-current row.
    expect(screen.queryByTestId('sessions-revoke-s1')).not.toBeInTheDocument();
    expect(screen.getByTestId('sessions-revoke-s2')).toBeInTheDocument();
  });

  it('clicking Revoke calls revokeSession + refresh', async () => {
    const user = userEvent.setup();
    const api = fakeApi([{ ...makeSession({ id: 's2' }) }]);
    render(<SessionsTab api={api} />);
    await screen.findByTestId('sessions-revoke-s2');
    await user.click(screen.getByTestId('sessions-revoke-s2'));
    await waitFor(() => expect(api.revokeSession).toHaveBeenCalledWith('s2'));
    // Refresh was called twice: initial + post-revoke.
    expect(api.listActiveSessions).toHaveBeenCalledTimes(2);
  });

  it('Sign out others is rendered ONLY when there is at least one non-current session', async () => {
    const { rerender } = render(
      <SessionsTab
        api={fakeApi([
          { ...makeSession({ id: 's1', current: true }) },
          { ...makeSession({ id: 's2', current: false }) },
        ])}
      />,
    );
    await screen.findByTestId('sessions-table');
    expect(screen.getByTestId('sessions-revoke-others')).toBeInTheDocument();

    rerender(
      <SessionsTab
        api={fakeApi([{ ...makeSession({ id: 's1', current: true }) }])}
      />,
    );
    await screen.findByTestId('sessions-table');
    expect(screen.queryByTestId('sessions-revoke-others')).not.toBeInTheDocument();
  });

  it('Sign out others calls revokeOtherSessions + refresh', async () => {
    const user = userEvent.setup();
    const api = fakeApi([
      { ...makeSession({ id: 's1', current: true }) },
      { ...makeSession({ id: 's2', current: false }) },
    ]);
    render(<SessionsTab api={api} />);
    await screen.findByTestId('sessions-revoke-others');
    await user.click(screen.getByTestId('sessions-revoke-others'));
    await waitFor(() => expect(api.revokeOtherSessions).toHaveBeenCalled());
    expect(api.listActiveSessions).toHaveBeenCalledTimes(2);
  });

  it('empty state when listActiveSessions returns []', async () => {
    render(<SessionsTab api={fakeApi([])} />);
    await screen.findByTestId('sessions-empty');
    expect(screen.queryByTestId('sessions-table')).not.toBeInTheDocument();
  });

  it('renders IP and user agent in the row', async () => {
    render(
      <SessionsTab
        api={fakeApi([
          { ...makeSession({ id: 's1', ip: '198.51.100.7', userAgent: 'Edge 121' }) },
        ])}
      />,
    );
    const row = await screen.findByTestId('sessions-row-s1');
    expect(row.textContent).toContain('198.51.100.7');
    expect(row.textContent).toContain('Edge 121');
  });

  it('null user_agent renders em-dash placeholder', async () => {
    render(
      <SessionsTab
        api={fakeApi([{ ...makeSession({ id: 's1', userAgent: null, ip: null }) }])}
      />,
    );
    const row = await screen.findByTestId('sessions-row-s1');
    expect(row.textContent).toContain('—');
  });
});

describe('SessionsTab — errors', () => {
  it('shows error from listActiveSessions in role=alert', async () => {
    const api: ApiClient = {
      listActiveSessions: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as ApiClient;
    render(<SessionsTab api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/boom/);
  });

  it('shows error from revokeSession', async () => {
    const user = userEvent.setup();
    const api = fakeApi([{ ...makeSession({ id: 's2' }) }]);
    (api.revokeSession as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new Error('forbidden'),
    );
    render(<SessionsTab api={api} />);
    await user.click(await screen.findByTestId('sessions-revoke-s2'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/forbidden/);
  });
});
