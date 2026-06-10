import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { httpApi } from './api';

/**
 * CSRF coverage for the cookie-auth POST endpoints that used to ship a bare
 * `{ method: 'POST' }` and got 403'd by the server gate in server mode.
 * Pre-auth routes (login, forgot, passkey authenticate-options) are exempt —
 * they run without a session cookie, so the gate doesn't apply.
 */
describe('httpApi — CSRF header on state-changing requests', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    document.cookie = 'diluxite_csrf=tok-123';
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // jsdom cookies persist across tests — expire it explicitly.
    document.cookie = 'diluxite_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  function headersOfCall(n = 0): Record<string, string> {
    const init = fetchMock.mock.calls[n][1] as RequestInit | undefined;
    return (init?.headers ?? {}) as Record<string, string>;
  }

  it('revokeAllTokens sends x-csrf-token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ revoked: 2 }), { status: 200 }),
    );
    await httpApi().revokeAllTokens();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tokens/revoke-all',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(headersOfCall()['x-csrf-token']).toBe('tok-123');
  });

  it('registerPasskey sends x-csrf-token on register-options', async () => {
    // Fail the options call so the flow stops before the WebAuthn ceremony —
    // we only care about the header on the first request.
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(httpApi().registerPasskey('mi llave')).rejects.toThrow(
      'register-options HTTP 403',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/passkey/register-options',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(headersOfCall()['x-csrf-token']).toBe('tok-123');
  });
});
