import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from './UpdateBanner';

const DISMISS_KEY = 'diluxite:update-banner:dismissed-version';

type CheckResult = {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  releaseNotesUrl?: string | null;
  releasedAt?: string | null;
  error?: string;
};

/** Stub global fetch so /api/update/check resolves with the given payload. */
function mockFetch(result: CheckResult, opts: { ok?: boolean } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok: opts.ok ?? true,
    json: async () => result,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('UpdateBanner', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the banner when a newer version is available', async () => {
    mockFetch({
      current: '1.0.0',
      latest: '1.2.0',
      hasUpdate: true,
      releaseNotesUrl: 'https://example.com/releases/1.2.0',
    });
    render(<UpdateBanner />);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Diluxite v1\.2\.0 disponible/)).toBeInTheDocument();
    expect(screen.getByText(/estás en v1\.0\.0/)).toBeInTheDocument();
    // Shows the manual-update command (we never run docker for the user).
    expect(
      screen.getByText(/docker compose pull && docker compose up -d/),
    ).toBeInTheDocument();
  });

  it('renders the release-notes link when releaseNotesUrl is present', async () => {
    mockFetch({
      current: '1.0.0',
      latest: '1.2.0',
      hasUpdate: true,
      releaseNotesUrl: 'https://example.com/releases/1.2.0',
    });
    render(<UpdateBanner />);

    const link = await screen.findByRole('link', { name: /ver cambios/i });
    expect(link).toHaveAttribute('href', 'https://example.com/releases/1.2.0');
  });

  it('omits the release-notes link when releaseNotesUrl is absent', async () => {
    mockFetch({
      current: '1.0.0',
      latest: '1.2.0',
      hasUpdate: true,
      releaseNotesUrl: null,
    });
    render(<UpdateBanner />);

    await screen.findByRole('status');
    expect(screen.queryByRole('link', { name: /ver cambios/i })).not.toBeInTheDocument();
  });

  it('stays hidden when up-to-date (hasUpdate=false)', async () => {
    mockFetch({ current: '1.2.0', latest: '1.2.0', hasUpdate: false });
    render(<UpdateBanner />);

    // Give the effect a chance to resolve, then assert nothing rendered.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays hidden when latest is null even if hasUpdate is true', async () => {
    mockFetch({ current: '1.0.0', latest: null, hasUpdate: true });
    render(<UpdateBanner />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays hidden when the fetch response is not ok', async () => {
    mockFetch(
      { current: '1.0.0', latest: '1.2.0', hasUpdate: true },
      { ok: false },
    );
    render(<UpdateBanner />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays hidden when fetch rejects (no network, no banner)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fn);
    render(<UpdateBanner />);

    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('clicking dismiss hides the banner and persists the version to localStorage', async () => {
    const user = userEvent.setup();
    mockFetch({ current: '1.0.0', latest: '1.2.0', hasUpdate: true });
    render(<UpdateBanner />);

    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: /cerrar/i }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1.2.0');
  });

  it('does not render if the latest version was already dismissed', async () => {
    localStorage.setItem(DISMISS_KEY, '1.2.0');
    mockFetch({ current: '1.0.0', latest: '1.2.0', hasUpdate: true });
    render(<UpdateBanner />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still renders when a DIFFERENT (older) version was dismissed', async () => {
    localStorage.setItem(DISMISS_KEY, '1.1.0');
    mockFetch({ current: '1.0.0', latest: '1.2.0', hasUpdate: true });
    render(<UpdateBanner />);

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/Diluxite v1\.2\.0 disponible/)).toBeInTheDocument();
  });
});
