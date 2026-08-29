import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithCtx } from '../../../test/render-with-ctx';
import { CurrentWorkspaceTab } from './CurrentWorkspaceTab';

/**
 * The export button is the only way most people will ever get their notes out
 * of Diluxite, so what it hands over matters more than how it looks.
 */
describe('CurrentWorkspaceTab', () => {
  let downloaded: { name: string; href: string } | null;
  let revoked: string[];

  beforeEach(() => {
    downloaded = null;
    revoked = [];
    // jsdom has no download: intercept the click on the anchor the component
    // creates, which is also the only place the filename is observable.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      // Record the two fields rather than the element: the anchor is created
      // and discarded inside the handler, so this is the only moment either
      // value is observable.
      downloaded = { name: this.download, href: this.href };
    });
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn((u: string) => revoked.push(u));
  });

  afterEach(() => vi.restoreAllMocks());

  it('downloads the ZIP under the name the server chose', async () => {
    const user = userEvent.setup();
    const exportZip = vi
      .fn()
      .mockResolvedValue({ blob: new Blob(['zip']), filename: 'Mi espacio.zip' });
    renderWithCtx(<CurrentWorkspaceTab />, { spaceId: 'space-1', api: { exportZip, stats: vi.fn().mockResolvedValue({ notes: 1, tags: 0, links: 0 }) } });

    await user.click(screen.getByTestId('space-export'));

    await waitFor(() => expect(exportZip).toHaveBeenCalledWith('space-1'));
    // The server names the file after the workspace; a client-side default
    // would call every export the same thing.
    expect(downloaded?.name).toBe('Mi espacio.zip');
  });

  it('releases the object URL — a whole workspace must not stay in memory', async () => {
    const user = userEvent.setup();
    const exportZip = vi.fn().mockResolvedValue({ blob: new Blob(['zip']), filename: 'w.zip' });
    renderWithCtx(<CurrentWorkspaceTab />, { spaceId: 'space-1', api: { exportZip, stats: vi.fn().mockResolvedValue({ notes: 0, tags: 0, links: 0 }) } });

    await user.click(screen.getByTestId('space-export'));
    await waitFor(() => expect(revoked).toEqual(['blob:fake']));
  });

  it('says what went wrong instead of failing silently', async () => {
    const user = userEvent.setup();
    const exportZip = vi.fn().mockRejectedValue(new Error('export failed: HTTP 403'));
    renderWithCtx(<CurrentWorkspaceTab />, { spaceId: 'space-1', api: { exportZip, stats: vi.fn().mockResolvedValue({ notes: 0, tags: 0, links: 0 }) } });

    await user.click(screen.getByTestId('space-export'));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
    // And the button comes back, rather than being stuck on "Preparing…".
    await waitFor(() => expect(screen.getByTestId('space-export')).toBeEnabled());
  });

  it('shows the workspace stats', async () => {
    const stats = vi.fn().mockResolvedValue({ notes: 12, tags: 3, links: 7 });
    renderWithCtx(<CurrentWorkspaceTab />, { spaceId: 'space-1', api: { stats } });
    expect(await screen.findByTestId('space-stats')).toHaveTextContent('12 notas · 3 tags · 7 links');
  });

  it('offers nothing to export without a workspace', () => {
    renderWithCtx(<CurrentWorkspaceTab />, { spaceId: null });
    expect(screen.queryByTestId('space-export')).toBeNull();
    expect(screen.getByText(/No workspace selected/i)).toBeInTheDocument();
  });
});
