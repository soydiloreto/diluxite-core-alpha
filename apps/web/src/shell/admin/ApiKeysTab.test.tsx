import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysTab } from './ApiKeysTab';
import type { ApiClient, TokenInfo } from '../../api';
import { renderWithCtx } from '../../../test/render-with-ctx';

function makeApi(tokens: TokenInfo[]): ApiClient {
  return {
    listTokens: vi.fn(async () => tokens),
    mintToken: vi.fn(async (name: string) => ({
      id: 't-new',
      name,
      token: 'mcp_tok_freshly_minted',
    })),
    revokeToken: vi.fn(async () => undefined),
  } as unknown as ApiClient;
}

describe('ApiKeysTab', () => {
  it('renders the header without crashing', async () => {
    const api = makeApi([]);
    renderWithCtx(<ApiKeysTab />, { api });
    expect(await screen.findByText(/API keys/i)).toBeInTheDocument();
  });

  it('lists the tokens returned by the api', async () => {
    const api = makeApi([
      { id: 't-1', name: 'Claude desktop' },
      { id: 't-2', name: 'Copilot' },
    ]);
    renderWithCtx(<ApiKeysTab />, { api });
    expect(await screen.findByText('Claude desktop')).toBeInTheDocument();
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });

  it('renders an empty state when there are no tokens', async () => {
    const api = makeApi([]);
    renderWithCtx(<ApiKeysTab />, { api });
    expect(await screen.findByText(/No active tokens/i)).toBeInTheDocument();
  });

  it('Mint calls api.mintToken and shows the freshly minted secret once', async () => {
    const user = userEvent.setup();
    const api = makeApi([]);
    renderWithCtx(<ApiKeysTab />, { api });
    await screen.findByText(/No active tokens/i);
    await user.type(screen.getByLabelText(/new token name/i), 'Claude desktop');
    await user.click(screen.getByRole('button', { name: /^mint$/i }));
    await waitFor(() => {
      expect(api.mintToken).toHaveBeenCalledWith('Claude desktop');
    });
    const minted = await screen.findByTestId('minted-token');
    expect(minted.textContent ?? '').toMatch(/mcp_tok_/);
  });

  it('Revoke confirms then calls api.revokeToken with the token id', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ id: 't-1', name: 'Claude desktop' }]);
    renderWithCtx(<ApiKeysTab />, { api });
    await screen.findByText('Claude desktop');
    await user.click(screen.getByRole('button', { name: /revoke claude desktop/i }));
    await user.click(await screen.findByRole('button', { name: /^revoke$/i }));
    await waitFor(() => {
      expect(api.revokeToken).toHaveBeenCalledWith('t-1');
    });
  });
});
