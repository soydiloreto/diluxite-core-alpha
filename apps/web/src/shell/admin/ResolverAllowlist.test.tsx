import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResolverAllowlist } from './ResolverAllowlist';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { ApiClient, AllowedHost } from '../../api';

const HOST: AllowedHost = {
  id: 'a1',
  orgId: 'o1',
  host: 'metrics.example',
  note: 'our metrics API',
  hasToken: true,
  createdAt: new Date().toISOString(),
};

function apiWith(over: Partial<ApiClient>): ApiClient {
  return {
    resolverAllowlist: vi.fn().mockResolvedValue([]),
    allowResolverHost: vi.fn().mockResolvedValue(HOST),
    revokeResolverHost: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  } as unknown as ApiClient;
}

describe('ResolverAllowlist', () => {
  it('says what the list is for: the note says where, the operator says which hosts', async () => {
    renderWithCtx(<ResolverAllowlist orgId="o1" />, { api: apiWith({}) });
    expect(await screen.findByText(/Nothing is called unless its host is on this list/i)).toBeInTheDocument();
    expect(screen.getByText(/never sits inside a note/i)).toBeInTheDocument();
  });

  it('lists the allowed hosts and marks the ones with a credential', async () => {
    const api = apiWith({ resolverAllowlist: vi.fn().mockResolvedValue([HOST]) });
    renderWithCtx(<ResolverAllowlist orgId="o1" />, { api });
    expect(await screen.findByText('metrics.example')).toBeInTheDocument();
    expect(screen.getByText('token')).toBeInTheDocument();
  });

  it('allows a host, sending the token only when one was typed', async () => {
    const allowResolverHost = vi.fn().mockResolvedValue(HOST);
    renderWithCtx(<ResolverAllowlist orgId="o1" />, { api: apiWith({ allowResolverHost }) });
    await userEvent.type(await screen.findByLabelText('Host'), 'metrics.example');
    await userEvent.click(screen.getByRole('button', { name: /Allow this host/i }));
    await waitFor(() =>
      expect(allowResolverHost).toHaveBeenCalledWith('o1', { host: 'metrics.example' }),
    );
  });

  it('revoking calls through with the entry id', async () => {
    const revokeResolverHost = vi.fn().mockResolvedValue({ ok: true });
    const api = apiWith({
      resolverAllowlist: vi.fn().mockResolvedValue([HOST]),
      revokeResolverHost,
    });
    renderWithCtx(<ResolverAllowlist orgId="o1" />, { api });
    await userEvent.click(await screen.findByRole('button', { name: 'revoke metrics.example' }));
    await waitFor(() => expect(revokeResolverHost).toHaveBeenCalledWith('o1', 'a1'));
  });

  it('an empty host cannot be submitted', async () => {
    renderWithCtx(<ResolverAllowlist orgId="o1" />, { api: apiWith({}) });
    expect(await screen.findByRole('button', { name: /Allow this host/i })).toBeDisabled();
  });
});
