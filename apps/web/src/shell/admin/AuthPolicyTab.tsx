import { useEffect, useState } from 'react';
import type { ApiClient, AuthPolicyValue } from '../../api';
import { Button, Field } from '../../ui';

/**
 * Admin → Settings → Auth tab. Dropdown to switch the org's auth policy
 * (what to do when an external IdP authenticates someone the users table
 * doesn't know yet).
 *
 * Renders descriptions of each option so the admin can choose without
 * memorising the enum, and a warning when picking the restrictive ones
 * — they imply the admin already uploaded the user list via CSV.
 */

const OPTIONS: Array<{
  value: AuthPolicyValue;
  title: string;
  body: string;
  warning?: string;
}> = [
  {
    value: 'allow_unknown_as_member',
    title: 'Auto-create as member',
    body:
      'When someone passes SSO with an email we have NOT seen, we create the user automatically with role "member" (no workspace access by default). The admin promotes them after.',
  },
  {
    value: 'deny_unknown',
    title: 'Deny unknown users',
    body:
      'Only users that already exist in Diluxite can sign in. New emails get HTTP 403. Strict — use if you keep the user list in lockstep with your IdP via CSV import.',
    warning: 'Make sure you imported the user CSV BEFORE switching to this. Otherwise nobody (including you) can sign in.',
  },
  {
    value: 'pre_provisioned_only',
    title: 'Pre-provisioned only',
    body:
      'Same as Deny unknown, but with a friendly message that tells the user to ask the admin for an account. Best UX when you do staged onboardings.',
    warning: 'Import the user CSV first.',
  },
];

export function AuthPolicyTab({ api, orgId }: { api: ApiClient; orgId: string }) {
  const [policy, setPolicy] = useState<AuthPolicyValue | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<AuthPolicyValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .getAuthPolicy(orgId)
      .then((p) => {
        if (p === null) setError('OIDC is not configured on this instance — policy does not apply.');
        else setPolicy(p);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [api, orgId]);

  async function save(next: AuthPolicyValue) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.setAuthPolicy(orgId, next);
      setPolicy(r.policy);
      setSaved(r.policy);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div data-testid="auth-policy-tab" className="text-sm text-ink-muted">
        Loading…
      </div>
    );
  }

  return (
    <div data-testid="auth-policy-tab" className="flex flex-col gap-4 max-w-2xl">
      <header>
        <h3 className="text-lg font-semibold">Auth policy</h3>
        <p className="text-xs text-ink-muted mt-1">
          How to handle SSO logins whose email isn't in your users list yet. Applies to
          OIDC (Okta / Entra / Google / Authentik) and to the trusted-header proxy flow.
        </p>
      </header>

      {error && (
        <p className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded p-2" role="alert">
          {error}
        </p>
      )}

      {policy && (
        <Field label="Current policy">
          <div className="flex flex-col gap-2">
            {OPTIONS.map((opt) => {
              const selected = opt.value === policy;
              return (
                <label
                  key={opt.value}
                  data-testid={`auth-policy-option-${opt.value}`}
                  className={`flex gap-2 items-start p-3 rounded border ${
                    selected ? 'border-brand bg-brand-soft/30' : 'border-line bg-bg'
                  } cursor-pointer`}
                >
                  <input
                    type="radio"
                    name="auth-policy"
                    value={opt.value}
                    checked={selected}
                    onChange={() => save(opt.value)}
                    disabled={busy}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink">{opt.title}</div>
                    <div className="text-xs text-ink-muted mt-1">{opt.body}</div>
                    {opt.warning && (
                      <div className="text-[11px] text-amber-400 mt-1.5">⚠️ {opt.warning}</div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </Field>
      )}

      {saved && (
        <p
          data-testid="auth-policy-saved"
          className="text-xs p-2 rounded border border-brand bg-brand-soft text-ink"
        >
          ✅ Saved. New policy: <strong>{saved}</strong>
        </p>
      )}

      {!policy && !loading && !error && (
        <p className="text-xs text-ink-muted">
          No policy data — make sure your server has OIDC environment variables set.
        </p>
      )}
    </div>
  );
}
