import { useEffect, useState } from 'react';
import type { ApiClient } from '../api';
import { Button } from '../ui';

/**
 * Settings → Two-factor authentication.
 *
 * Two states: enrolled (show "disable" + backup codes remaining) or not
 * enrolled (show the enroll wizard: enroll → QR + secret → user types first
 * code → backup codes shown ONCE).
 */
export function TwoFactorTab({ api }: { api: ApiClient }) {
  const [enabled, setEnabled] = useState(false);
  const [backupCodesRemaining, setBackupCodesRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enrollment in-progress state.
  const [enrollSecret, setEnrollSecret] = useState<string | null>(null);
  const [enrollOtpauthUrl, setEnrollOtpauthUrl] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [newBackupCodes, setNewBackupCodes] = useState<string[] | null>(null);

  async function refreshStatus() {
    setLoading(true);
    setError(null);
    try {
      const s = await api.totpStatus();
      setEnabled(s.enabled);
      setBackupCodesRemaining(s.backupCodesRemaining);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  async function startEnroll() {
    setError(null);
    setEnrollBusy(true);
    try {
      const r = await api.totpEnroll();
      setEnrollSecret(r.secret);
      setEnrollOtpauthUrl(r.otpauthUrl);
      setEnrollCode('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrollBusy(false);
    }
  }

  async function verifyEnroll() {
    if (!enrollSecret) return;
    setError(null);
    setEnrollBusy(true);
    try {
      const r = await api.totpVerifyEnroll(enrollSecret, enrollCode.trim());
      setNewBackupCodes(r.backupCodes);
      // Close the enrolment form (we keep the backup codes view until the
      // user acknowledges by clicking Done).
      setEnrollSecret(null);
      setEnrollOtpauthUrl(null);
      setEnrollCode('');
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnrollBusy(false);
    }
  }

  async function disable() {
    setError(null);
    try {
      await api.totpDisable();
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div data-testid="twofactor-tab" className="flex flex-col gap-4 max-w-xl">
      <header>
        <h3 className="text-lg font-semibold">Two-factor authentication (2FA)</h3>
        <p className="text-xs text-ink-muted mt-1">
          Scan the QR with Google Authenticator, 1Password, Authy or any OTP app. We'll require a
          6-digit code from your phone in addition to your password every time you sign in.
        </p>
      </header>

      {error && (
        <p
          role="alert"
          className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : newBackupCodes ? (
        <BackupCodesView codes={newBackupCodes} onDone={() => setNewBackupCodes(null)} />
      ) : enabled ? (
        <section
          data-testid="twofactor-enabled"
          className="flex flex-col gap-3 border border-line rounded p-4 bg-bg-soft"
        >
          <p className="text-sm font-medium text-ink">✅ 2FA is active on this account.</p>
          <p className="text-xs text-ink-muted">
            {backupCodesRemaining} backup codes remaining.{' '}
            {backupCodesRemaining <= 3 && (
              <span className="text-amber-400">
                You're running low — disable + re-enroll to generate fresh codes.
              </span>
            )}
          </p>
          <Button
            data-testid="twofactor-disable"
            variant="danger"
            onClick={disable}
          >
            Disable 2FA
          </Button>
        </section>
      ) : enrollSecret && enrollOtpauthUrl ? (
        <section
          data-testid="twofactor-enroll-form"
          className="flex flex-col gap-3 border border-line rounded p-4"
        >
          <p className="text-sm">1. Scan this QR with your authenticator app:</p>
          <a
            href={enrollOtpauthUrl}
            data-testid="twofactor-otpauth-link"
            className="text-xs underline text-brand break-all"
          >
            {enrollOtpauthUrl}
          </a>
          <p className="text-xs text-ink-muted">
            Or enter this secret manually: <code data-testid="twofactor-secret">{enrollSecret}</code>
          </p>
          <p className="text-sm">2. Enter the 6-digit code your app shows:</p>
          <input
            data-testid="twofactor-enroll-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={enrollCode}
            onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
            className="border border-line bg-bg text-ink rounded px-3 py-2 text-base font-mono tracking-widest w-32"
          />
          <Button
            data-testid="twofactor-enroll-verify"
            onClick={verifyEnroll}
            disabled={enrollBusy || enrollCode.length < 6}
          >
            {enrollBusy ? 'Verifying…' : 'Enable 2FA'}
          </Button>
        </section>
      ) : (
        <section
          data-testid="twofactor-disabled"
          className="flex flex-col gap-3 border border-line rounded p-4"
        >
          <p className="text-sm">2FA is not configured.</p>
          <Button
            data-testid="twofactor-start-enroll"
            onClick={startEnroll}
            disabled={enrollBusy}
          >
            {enrollBusy ? 'Loading…' : 'Enable 2FA'}
          </Button>
        </section>
      )}
    </div>
  );
}

function BackupCodesView({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const text = codes.join('\n');
  return (
    <section
      data-testid="twofactor-backup-codes"
      className="flex flex-col gap-3 border border-brand bg-brand-soft/30 rounded p-4"
    >
      <h4 className="text-sm font-semibold">Save these backup codes</h4>
      <p className="text-xs text-ink-muted">
        Each code works once. Print them, save them in your password manager, or stash them
        somewhere safe. We won't show them again.
      </p>
      <pre
        data-testid="twofactor-backup-codes-list"
        className="font-mono text-sm bg-bg border border-line rounded p-3 grid grid-cols-2 gap-x-6 gap-y-1"
      >
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <div className="flex gap-2">
        <Button
          data-testid="twofactor-copy-codes"
          variant="secondary"
          onClick={() => navigator.clipboard.writeText(text)}
        >
          Copy to clipboard
        </Button>
        <Button data-testid="twofactor-backup-codes-done" onClick={onDone}>
          I've saved them
        </Button>
      </div>
    </section>
  );
}
