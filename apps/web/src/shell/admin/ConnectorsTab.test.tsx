import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectorsTab } from './ConnectorsTab';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { ApiClient, GithubConnection, OrganizationWithRole } from '../../api';

const ORG = { id: 'o1', name: 'Acme', slug: 'acme', role: 'org_admin' } as OrganizationWithRole;

const CONNECTED: GithubConnection = {
  configured: true,
  installUrl: 'https://github.com/apps/x/installations/new?state=o1',
  installation: {
    orgId: 'o1',
    installationId: '42',
    accountLogin: 'acme-inc',
    connectedAt: '2026-09-01T10:00:00.000Z',
    lastSyncAt: null,
    lastSyncError: null,
  },
};

function apiWith(over: Partial<ApiClient>): ApiClient {
  return {
    githubConnection: vi.fn().mockResolvedValue(CONNECTED),
    syncGithub: vi.fn().mockResolvedValue({ reports: [] }),
    disconnectGithub: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as unknown as ApiClient;
}

describe('ConnectorsTab', () => {
  it('says nobody pastes a token here', async () => {
    renderWithCtx(<ConnectorsTab org={ORG} />, { api: apiWith({}) });
    // It is the whole point of the App model, and the screen where somebody
    // would look for a token field is where it has to be said.
    expect(await screen.findByText(/do not paste a token/i)).toBeInTheDocument();
  });

  it('an unconfigured instance says so instead of offering a dead button', async () => {
    const api = apiWith({
      githubConnection: vi.fn().mockResolvedValue({ configured: false, installation: null }),
    });
    renderWithCtx(<ConnectorsTab org={ORG} />, { api });
    expect(await screen.findByText(/no GitHub App configured/i)).toBeInTheDocument();
    expect(screen.queryByTestId('github-install')).toBeNull();
  });

  it('offers the install link when nothing is connected yet', async () => {
    const api = apiWith({
      githubConnection: vi
        .fn()
        .mockResolvedValue({ ...CONNECTED, installation: null }),
    });
    renderWithCtx(<ConnectorsTab org={ORG} />, { api });
    const link = await screen.findByTestId('github-install');
    expect(link).toHaveAttribute('href', CONNECTED.installUrl);
  });

  it('shows the account and a sync report', async () => {
    const syncGithub = vi.fn().mockResolvedValue({
      reports: [
        { repo: 'acme/docs', created: 2, updated: 1, unchanged: 9, annotated: 1, skipped: [], truncated: false },
      ],
    });
    renderWithCtx(<ConnectorsTab org={ORG} />, { api: apiWith({ syncGithub }) });
    expect(await screen.findByText('acme-inc')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Sync now/i }));
    const report = await screen.findByTestId('sync-report');
    expect(report).toHaveTextContent('acme/docs');
    expect(report).toHaveTextContent('9 unchanged');
    expect(report).toHaveTextContent('marked as removed at source');
  });

  it('a failed sync is surfaced instead of silently doing nothing', async () => {
    const syncGithub = vi.fn().mockRejectedValue(new Error('GitHub answered 401'));
    renderWithCtx(<ConnectorsTab org={ORG} />, { api: apiWith({ syncGithub }) });
    await screen.findByText('acme-inc');
    await userEvent.click(screen.getByRole('button', { name: /Sync now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('401');
  });

  it('disconnecting says the notes stay', async () => {
    const disconnectGithub = vi.fn().mockResolvedValue({ ok: true });
    renderWithCtx(<ConnectorsTab org={ORG} />, { api: apiWith({ disconnectGithub }) });
    await screen.findByText('acme-inc');
    await userEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    // "Disconnect" reads as "delete" to most people, and this one deletes
    // nothing.
    expect(await screen.findByText(/notes stay where they are/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^OK$|Confirm|Sí/i }));
    await waitFor(() => expect(disconnectGithub).toHaveBeenCalledWith('o1'));
  });
});
