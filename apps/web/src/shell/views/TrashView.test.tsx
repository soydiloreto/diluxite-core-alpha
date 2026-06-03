import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrashView } from './TrashView';
import { renderWithCtx } from '../../../test/render-with-ctx';
import { createFakeApi } from '../../fakeApi';
import type { NoteRef } from '../../api';

function makeApi(initialTrash: NoteRef[] = []) {
  const api = createFakeApi({ authMode: 'local' });
  // Override listTrash to start with the given items; the rest of the
  // contract (restore + purge + emptyTrash) we exercise through the real fake.
  api.listTrash = vi.fn().mockResolvedValue(initialTrash);
  return api;
}

describe('TrashView', () => {
  it('shows empty state when there is nothing in trash', async () => {
    renderWithCtx(<TrashView />, { api: makeApi([]), spaceId: 'space-1' });
    expect(await screen.findByText(/trash is empty/i)).toBeInTheDocument();
    expect(screen.queryByTestId('empty-trash')).not.toBeInTheDocument();
  });

  it('lists trashed notes + shows the empty-trash button when populated', async () => {
    const api = makeApi([
      { id: 'n1', title: 'first deleted' },
      { id: 'n2', title: 'second deleted' },
    ]);
    renderWithCtx(<TrashView />, { api, spaceId: 'space-1' });
    expect(await screen.findByText('first deleted')).toBeInTheDocument();
    expect(screen.getByText('second deleted')).toBeInTheDocument();
    expect(screen.getByTestId('empty-trash')).toBeInTheDocument();
    expect(screen.getByTestId('empty-trash').textContent).toMatch(/Empty trash \(2\)/);
  });

  it('clicking Restore calls api.restoreNote + triggers refreshAll', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ id: 'n1', title: 'oops' }]);
    api.restoreNote = vi
      .fn()
      .mockResolvedValue({ ok: true, note: { id: 'n1', title: 'oops' } });
    const refreshAll = vi.fn().mockResolvedValue(undefined);
    renderWithCtx(<TrashView />, { api, spaceId: 'space-1', refreshAll });

    await screen.findByText('oops');
    await user.click(screen.getByLabelText(/restore oops/i));

    await waitFor(() => expect(api.restoreNote).toHaveBeenCalledWith('n1'));
    expect(refreshAll).toHaveBeenCalled();
  });

  it('clicking Purge asks for confirm; on confirm calls api.purgeNote', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ id: 'n1', title: 'forever' }]);
    api.purgeNote = vi.fn().mockResolvedValue({ ok: true });
    renderWithCtx(<TrashView />, { api, spaceId: 'space-1' });

    await screen.findByText('forever');
    await user.click(screen.getByLabelText(/purge forever/i));

    // Confirm dialog.
    const confirm = await screen.findByTestId('confirm-dialog');
    await user.click(within(confirm).getByRole('button', { name: /delete forever/i }));

    await waitFor(() => expect(api.purgeNote).toHaveBeenCalledWith('n1'));
  });

  it('clicking Purge + cancel does NOT call api.purgeNote', async () => {
    const user = userEvent.setup();
    const api = makeApi([{ id: 'n1', title: 'forever' }]);
    api.purgeNote = vi.fn();
    renderWithCtx(<TrashView />, { api, spaceId: 'space-1' });

    await screen.findByText('forever');
    await user.click(screen.getByLabelText(/purge forever/i));
    const confirm = await screen.findByTestId('confirm-dialog');
    await user.click(within(confirm).getByRole('button', { name: /cancel/i }));

    expect(api.purgeNote).not.toHaveBeenCalled();
  });

  it('"Empty trash" with confirm calls api.emptyTrash', async () => {
    const user = userEvent.setup();
    const api = makeApi([
      { id: 'n1', title: 'a' },
      { id: 'n2', title: 'b' },
    ]);
    api.emptyTrash = vi.fn().mockResolvedValue({ ok: true, purged: 2 });
    renderWithCtx(<TrashView />, { api, spaceId: 'space-1' });

    await screen.findByText('a');
    await user.click(screen.getByTestId('empty-trash'));
    const confirm = await screen.findByTestId('confirm-dialog');
    await user.click(within(confirm).getByRole('button', { name: /empty trash/i }));

    await waitFor(() => expect(api.emptyTrash).toHaveBeenCalledWith('space-1'));
  });
});

// `within` shadowed locally for clarity in the tests above.
import { within } from '@testing-library/react';
