import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { LoginScreen } from './LoginScreen';
import { ForgotPasswordScreen } from './ForgotPasswordScreen';
import { ResetPasswordScreen } from './ResetPasswordScreen';

type GateState =
  | { kind: 'loading' }
  | { kind: 'authenticated' }
  | { kind: 'login-required' }
  | { kind: 'error'; message: string };

/**
 * AppGate — decides whether to render the shell or the login screen.
 *
 * Flow:
 *   1. On mount, call `/api/info` (cheapest authenticated endpoint).
 *      - 200 → user is authenticated (local mode or server with a session) →
 *        render children (the shell).
 *      - 401 → server mode, no session → render `<LoginScreen>`.
 *      - other error → render an error panel, no shell.
 *   2. After a successful login the LoginScreen calls onSuccess(); the gate
 *      re-fetches /api/info and swaps to the shell.
 *
 * Local-mode installs never see the login screen because the single-user
 * auth provider treats every request as `local@diluxite`.
 */
export function AppGate({
  api,
  children,
}: {
  api: ApiClient;
  children: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  const probe = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      await api.info();
      setState({ kind: 'authenticated' });
    } catch (e) {
      // We use the HTTP status surfaced in the thrown Error message
      // (httpApi() throws "HTTP 401" etc.). A 401 means "needs login".
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b401\b/.test(msg) || /unauthenticated/i.test(msg)) {
        setState({ kind: 'login-required' });
      } else {
        setState({ kind: 'error', message: msg });
      }
    }
  }, [api]);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Pre-auth screens that bypass the shell entirely. Reachable via direct
  // URL — typically the user is logged out and clicked an email link or the
  // "Forgot your password?" link from the LoginScreen. We special-case these
  // here so they render even mid-`loading` (no flash of "Loading…" + login).
  if (typeof window !== 'undefined') {
    if (window.location.pathname === '/forgot') {
      return <ForgotPasswordScreen api={api} />;
    }
    if (window.location.pathname === '/reset') {
      const token = new URLSearchParams(window.location.search).get('token') ?? '';
      return <ResetPasswordScreen api={api} token={token} />;
    }
  }

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="app-gate-loading"
        className="min-h-screen flex items-center justify-center bg-bg text-ink-muted text-xs"
      >
        Loading…
      </div>
    );
  }

  if (state.kind === 'login-required') {
    return <LoginScreen api={api} onSuccess={probe} />;
  }

  if (state.kind === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-ink p-4">
        <div className="max-w-md text-center">
          <p className="text-sm text-red-400">Couldn't reach Diluxite: {state.message}</p>
          <p className="text-xs text-ink-muted mt-2">
            Check that the API container is up and try refreshing.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
