import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ValidityPanel } from './ValidityPanel';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { ApiClient, NoteValidity } from '../../api';

function validity(over: Partial<NonNullable<NoteValidity['provenance']>> = {}): NoteValidity {
  return {
    provenance: {
      attributedTo: 'u1',
      agentKind: 'user',
      generatedBy: 'editor',
      validFrom: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      validTo: null,
      rank: 'normal',
      confirmedBy: null,
      confirmedAt: null,
      ...over,
    },
    stats: null,
    expired: false,
  };
}

function apiWith(over: Partial<ApiClient>): ApiClient {
  return {
    noteValidity: vi.fn().mockResolvedValue(validity()),
    // The panel also shows live values (ADR-001 step 3); none, here.
    noteLiveValues: vi.fn().mockResolvedValue([]),
    ...over,
  } as unknown as ApiClient;
}

describe('ValidityPanel', () => {
  it('says who wrote it, that it still holds and that nobody signed it', async () => {
    renderWithCtx(<ValidityPanel noteId="n1" onClose={vi.fn()} />, { api: apiWith({}) });
    expect(await screen.findByText(/Still holds, no expiry/i)).toBeInTheDocument();
    expect(screen.getByText(/Nobody has signed it/i)).toBeInTheDocument();
    expect(screen.getByText(/by a person, in the app/i)).toBeInTheDocument();
  });

  it('a superseded note offers only "bring it back"', async () => {
    const api = apiWith({
      noteValidity: vi.fn().mockResolvedValue({
        ...validity({ rank: 'deprecated', validTo: new Date().toISOString() }),
        expired: true,
      }),
    });
    renderWithCtx(<ValidityPanel noteId="n1" onClose={vi.fn()} />, { api });
    expect(await screen.findByText(/^No longer true$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bring it back/i })).toBeInTheDocument();
    // Confirming something superseded is not a state anybody can explain, so
    // the panel does not offer it.
    expect(screen.queryByRole('button', { name: /It still holds/i })).toBeNull();
  });

  it('"no longer true" calls supersede and re-reads', async () => {
    const supersedeNote = vi.fn().mockResolvedValue(null);
    const noteValidity = vi.fn().mockResolvedValue(validity());
    renderWithCtx(<ValidityPanel noteId="n1" onClose={vi.fn()} />, {
      api: apiWith({ supersedeNote, noteValidity }),
    });
    await screen.findByText(/Still holds, no expiry/i);
    await userEvent.click(screen.getByRole('button', { name: /No longer true/i }));
    await waitFor(() => expect(supersedeNote).toHaveBeenCalledWith('n1'));
    expect(noteValidity).toHaveBeenCalledTimes(2);
  });

  it('setting an expiry sends the date as an ISO instant', async () => {
    const setNoteValidTo = vi.fn().mockResolvedValue(null);
    renderWithCtx(<ValidityPanel noteId="n1" onClose={vi.fn()} />, {
      api: apiWith({ setNoteValidTo }),
    });
    await screen.findByText(/Still holds, no expiry/i);
    await userEvent.click(screen.getByRole('button', { name: /Set an expiry date/i }));
    const input = screen.getByLabelText(/Set an expiry date/i);
    await userEvent.type(input, '2027-12-31');
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(setNoteValidTo).toHaveBeenCalledWith('n1', '2027-12-31T00:00:00.000Z'),
    );
  });

  it('an expiry already in the past reads as expired', async () => {
    const api = apiWith({
      noteValidity: vi.fn().mockResolvedValue({
        ...validity({ validTo: new Date(Date.now() - 86_400_000).toISOString() }),
        expired: true,
      }),
    });
    renderWithCtx(<ValidityPanel noteId="n1" onClose={vi.fn()} />, { api });
    expect(await screen.findByText(/^Expired$/i)).toBeInTheDocument();
  });
});
