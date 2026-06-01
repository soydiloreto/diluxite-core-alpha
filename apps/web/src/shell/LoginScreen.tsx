import { useState, type FormEvent } from 'react';
import type { ApiClient } from '../api';
import { Button, Field, Input } from '../ui';

/**
 * LoginScreen — full-page email+password form for server-mode installs.
 *
 * Render decided by `<AppGate>`: in `local` mode this is bypassed entirely
 * (SingleUserAuthProvider treats the request as the local admin); in
 * `server` mode the gate calls `/api/info`; if it returns 401, this screen
 * is what the user sees.
 *
 * On successful login the API sets an HttpOnly cookie. We notify the parent
 * via `onSuccess` so it re-fetches `/api/info` and swaps into the shell.
 */
export function LoginScreen({
  api,
  onSuccess,
}: {
  api: ApiClient;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="login-screen"
      className="min-h-screen flex items-center justify-center bg-bg text-ink p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-line bg-bg-surface p-6 shadow-2xl">
        <header className="mb-4">
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <span className="text-brand">Diluxite</span>
          </h1>
          <p className="text-xs text-ink-muted mt-1">
            Sign in to your self-hosted memory.
          </p>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field label="Email">
            <Input
              aria-label="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoFocus
            />
          </Field>

          <Field label="Password">
            <Input
              aria-label="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>

          {error && (
            <p
              role="alert"
              className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2"
            >
              {error}
            </p>
          )}

          <Button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-[11px] text-ink-muted mt-4">
          Forgot your password? Reset it from the host:{' '}
          <code className="px-1 py-0.5 rounded bg-bg border border-line">
            docker compose exec api …
          </code>
        </p>
      </div>
    </div>
  );
}
