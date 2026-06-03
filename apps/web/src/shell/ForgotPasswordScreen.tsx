import { useState } from 'react';
import type { ApiClient } from '../api';
import { Button, Field, Input } from '../ui';

/**
 * ForgotPasswordScreen — full-page form to request a password-reset email.
 *
 * Reached from the LoginScreen "Forgot your password?" link. Posts to
 * `/api/auth/forgot` which ALWAYS returns 200 (no enumeration leak), so the
 * UI shows the same "check your email" confirmation whether the address is
 * registered or not.
 */
export function ForgotPasswordScreen({ api }: { api: ApiClient }) {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Email is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (e) {
      // Real errors (rate-limit 429, 5xx). We do NOT differentiate "email
      // not found" — the backend explicitly hides that.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm" data-testid="forgot-password-screen">
        <h1 className="text-2xl font-semibold text-ink text-center mb-2">
          Diluxite 🪨
        </h1>
        <p className="text-sm text-ink-muted text-center mb-6">
          Reset your password
        </p>

        {sent ? (
          <div
            data-testid="forgot-sent"
            className="border border-line bg-bg-surface rounded p-4 text-sm text-ink"
          >
            <p className="mb-2">
              If <strong>{email.trim()}</strong> is a registered account,
              we sent it a reset link.
            </p>
            <p className="text-xs text-ink-muted">
              The link is valid for 1 hour. Check your spam folder if you
              don't see it. You can close this tab.
            </p>
            <p className="mt-4 text-center">
              <a
                href="/"
                className="text-brand hover:underline text-xs"
                data-testid="back-to-login"
              >
                ← Back to sign in
              </a>
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                autoFocus
                aria-label="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
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

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Sending…' : 'Send reset link'}
            </Button>

            <p className="text-[11px] text-ink-muted text-center mt-2">
              <a href="/" className="text-brand hover:underline">
                ← Back to sign in
              </a>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
