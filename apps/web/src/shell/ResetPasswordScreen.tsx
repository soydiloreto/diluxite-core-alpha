import { useState } from 'react';
import type { ApiClient } from '../api';
import { Button, Field, Input } from '../ui';

/**
 * ResetPasswordScreen — full-page form to redeem a reset token from email.
 *
 * The token comes from the URL (`?token=...`) — we read it once on mount.
 * On success, the backend revokes all of the user's sessions, so they get
 * redirected to /login and have to sign in with the new password.
 */
export function ResetPasswordScreen({
  api,
  token,
}: {
  api: ApiClient;
  token: string;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-4">
        <div
          className="max-w-sm text-center"
          data-testid="reset-missing-token"
        >
          <h1 className="text-xl font-semibold text-ink mb-2">
            Missing reset token
          </h1>
          <p className="text-sm text-ink-muted mb-4">
            This page needs a valid token in the URL. Use the link we sent
            to your email.
          </p>
          <a href="/forgot" className="text-brand hover:underline text-sm">
            Request a new reset link
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm" data-testid="reset-password-screen">
        <h1 className="text-2xl font-semibold text-ink text-center mb-2">
          Diluxite 🪨
        </h1>
        <p className="text-sm text-ink-muted text-center mb-6">
          Set a new password
        </p>

        {done ? (
          <div
            data-testid="reset-done"
            className="border border-line bg-bg-surface rounded p-4 text-sm text-ink"
          >
            <p className="mb-2">Your password has been updated.</p>
            <p className="text-xs text-ink-muted">
              All your other sessions have been signed out. You can now sign
              in with your new password.
            </p>
            <p className="mt-4 text-center">
              <a
                href="/"
                className="text-brand hover:underline text-xs"
                data-testid="back-to-login"
              >
                ← Sign in
              </a>
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field label="New password">
              <Input
                type="password"
                autoComplete="new-password"
                autoFocus
                aria-label="new password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="at least 8 characters"
                disabled={submitting}
              />
            </Field>
            <Field label="Confirm new password">
              <Input
                type="password"
                autoComplete="new-password"
                aria-label="confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting}
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

            <Button
              type="submit"
              disabled={submitting || password.length < 8 || password !== confirm}
              className="w-full"
            >
              {submitting ? 'Updating…' : 'Set new password'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
