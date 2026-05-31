import { useEffect, useState } from 'react';

// Polls /api/update/check at mount time and once per hour after. If the
// server reports a newer version is available, render a dismissible banner
// with a link to the release notes and the manual-update command.
//
// We do NOT call docker on the user's behalf — exposing an endpoint that
// runs `docker compose pull && up -d` would require Docker socket access
// inside the api container, which is a remote-code-exec foot-gun (a bug in
// auth or input handling becomes root on the host). The banner shows the
// command, the user runs it.

type CheckResult = {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releaseNotesUrl?: string | null;
  releasedAt?: string | null;
  error?: string;
};

const DISMISS_KEY = 'diluxite:update-banner:dismissed-version';
const POLL_INTERVAL_MS = 60 * 60 * 1000;

export function UpdateBanner() {
  const [data, setData] = useState<CheckResult | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/api/update/check', { cache: 'no-cache' });
        if (!res.ok) return;
        const json = (await res.json()) as CheckResult;
        if (!cancelled) setData(json);
      } catch {
        // Silent — no network, no banner.
      }
    }
    void check();
    const id = window.setInterval(check, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!data?.hasUpdate || !data.latest) return null;
  if (dismissed === data.latest) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, data.latest!);
    } catch {
      // ignore
    }
    setDismissed(data.latest);
  };

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <span className="font-medium">Diluxite v{data.latest} disponible</span>
      <span className="text-amber-700 dark:text-amber-300">
        (estás en v{data.current})
      </span>
      {data.releaseNotesUrl && (
        <a
          href={data.releaseNotesUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline hover:no-underline"
        >
          ver cambios
        </a>
      )}
      <code className="ml-auto rounded bg-amber-100 px-2 py-0.5 text-xs dark:bg-amber-900">
        docker compose pull && docker compose up -d
      </code>
      <button
        type="button"
        onClick={dismiss}
        className="ml-2 text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
        aria-label="Cerrar"
      >
        ×
      </button>
    </div>
  );
}
