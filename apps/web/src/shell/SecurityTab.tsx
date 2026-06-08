import { useState } from 'react';
import type { ApiClient } from '../api';
import { useApp } from './AppContext';
import { PasskeysTab } from './PasskeysTab';
import { TwoFactorTab } from './TwoFactorTab';
import { SessionsTab } from './SessionsTab';

/**
 * Settings → Security.
 *
 * Consolida los tres tabs de seguridad user-level (passkeys, 2FA TOTP,
 * sesiones + password) en uno solo con secciones colapsables. Cada sub-tab
 * sigue siendo un componente independiente (tests propios, mountable
 * separado), acá solo los agrupamos para reducir ruido en la nav del modal.
 *
 * Default: la primera sección (passkeys) viene abierta para que el user
 * vea contenido sin tener que clickear.
 */
type Section = 'passkeys' | 'twofactor' | 'sessions';

const SECTIONS: Array<{ id: Section; title: string; subtitle: string }> = [
  {
    id: 'passkeys',
    title: 'Passkeys',
    subtitle: 'Sign in with Face ID / Touch ID / Windows Hello / hardware keys.',
  },
  {
    id: 'twofactor',
    title: 'Two-factor authentication',
    subtitle: '6-digit code from your authenticator app, plus backup codes.',
  },
  {
    id: 'sessions',
    title: 'Sessions & password',
    subtitle: 'Active devices, revoke individual sessions, change password.',
  },
];

export function SecurityTab({ api }: { api: ApiClient }) {
  const { authMode } = useApp();
  const locked = authMode !== 'server';
  const [open, setOpen] = useState<Section>('passkeys');

  return (
    <div data-testid="security-tab" className="flex flex-col gap-3 max-w-3xl">
      <header>
        <h3 className="text-lg font-semibold">Security</h3>
        <p className="text-xs text-ink-muted mt-1">
          Manage how you sign in and which devices are connected to your account.
        </p>
      </header>

      {locked && (
        <div
          data-testid="security-locked-banner"
          role="note"
          className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-ink"
        >
          <div className="font-medium mb-1">🔒 Security features need server mode</div>
          Passkeys, two-factor authentication and password changes only apply when Diluxite runs in{' '}
          <strong>server mode</strong> (multi-user, with login). Your install is in{' '}
          <strong>local single-user mode</strong>, so there's nothing to secure here — anyone who can
          reach the app is already &ldquo;you&rdquo;. To enable these, switch with the installer:{' '}
          <code className="px-1 bg-bg rounded">install.sh</code> → Reconfigure → Switch mode.
        </div>
      )}

      <div
        className={locked ? 'pointer-events-none opacity-50 select-none' : ''}
        aria-disabled={locked || undefined}
      >
      {SECTIONS.map((s) => {
        const isOpen = open === s.id;
        return (
          <section
            key={s.id}
            data-testid={`security-section-${s.id}`}
            className={`border border-line rounded ${isOpen ? 'bg-bg-surface' : 'bg-bg'}`}
          >
            <button
              type="button"
              data-testid={`security-toggle-${s.id}`}
              onClick={() => setOpen(isOpen ? ('' as Section) : s.id)}
              className="w-full text-left p-3 flex items-center justify-between hover:bg-bg-soft"
            >
              <div>
                <div className="text-sm font-medium text-ink">{s.title}</div>
                <div className="text-xs text-ink-muted mt-0.5">{s.subtitle}</div>
              </div>
              <span className="text-ink-muted text-sm">{isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <div className="border-t border-line p-4">
                {s.id === 'passkeys' && <PasskeysTab />}
                {s.id === 'twofactor' && <TwoFactorTab api={api} />}
                {s.id === 'sessions' && <SessionsTab api={api} />}
              </div>
            )}
          </section>
        );
      })}
      </div>
    </div>
  );
}
