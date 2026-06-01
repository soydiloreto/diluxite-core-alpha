import type { CollabConnectionStatus } from './CodeMirrorEditor';

/**
 * Inline banner that surfaces the collab WebSocket state above the note
 * editor. Hidden when collab is off (`status === null`) or when we're
 * happily connected — the silent default is "no news = good news".
 *
 * Visual rules
 * ────────────
 *  - `connecting`  amber — "still trying", no user action needed.
 *  - `disconnected` red  — "network blip", we'll reconnect automatically.
 *  - `auth-expired` red  — terminal until the user refreshes; the message
 *    is different so they don't sit waiting for a reconnect that won't
 *    succeed.
 */
export function CollabBanner({ status }: { status: CollabConnectionStatus | null }) {
  if (!status || status === 'connected') return null;

  const isRed = status === 'disconnected' || status === 'auth-expired';
  const className = `px-2 py-1 text-[11px] text-center shrink-0 ${
    isRed
      ? 'bg-red-500/15 text-red-400 border-b border-red-500/30'
      : 'bg-amber-500/15 text-amber-400 border-b border-amber-500/30'
  }`;

  return (
    <div data-testid="collab-banner" data-status={status} className={className}>
      {status === 'auth-expired' ? (
        <>
          🔒 Tu sesión expiró. Refrescá la página para iniciar sesión otra vez —
          tus cambios sin guardar se mantienen en este editor mientras tanto.
        </>
      ) : status === 'disconnected' ? (
        '🔴 Desconectado — la edición está deshabilitada. Reconectando…'
      ) : (
        '🟡 Conectando al servidor colaborativo…'
      )}
    </div>
  );
}
