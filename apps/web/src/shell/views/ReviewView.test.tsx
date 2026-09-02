import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewView } from './ReviewView';
import { renderWithCtx } from '../../../test/render-with-ctx';
import type { ApiClient, CurationItem } from '../../api';

function card(over: Partial<CurationItem> = {}): CurationItem {
  return {
    id: 'c1',
    noteId: 'n1',
    title: 'Acta de riesgo',
    question: 'Does this still hold?',
    citation: 'umbral_fraude — valor: 3%',
    sourceLine: 14,
    useCount: 9,
    score: 4.2,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function apiWith(over: Partial<ApiClient>): ApiClient {
  return {
    curationBatch: vi.fn().mockResolvedValue([card()]),
    decideCuration: vi.fn().mockResolvedValue({ ok: true, noteId: 'n1' }),
    buildCurationBatch: vi.fn().mockResolvedValue({ built: 0, budget: 10 }),
    ...over,
  } as unknown as ApiClient;
}

describe('ReviewView', () => {
  it('shows one card: the question, the citation and why it is being asked', async () => {
    renderWithCtx(<ReviewView />, { api: apiWith({}), spaceId: 's1' });
    expect(await screen.findByText('Does this still hold?')).toBeInTheDocument();
    expect(screen.getByText(/umbral_fraude — valor: 3%/)).toBeInTheDocument();
    expect(screen.getByText(/used 9 times/i)).toBeInTheDocument();
  });

  it('one card at a time — a list invites deciding in bulk', async () => {
    const api = apiWith({
      curationBatch: vi.fn().mockResolvedValue([card(), card({ id: 'c2', citation: 'otra' })]),
    });
    renderWithCtx(<ReviewView />, { api, spaceId: 's1' });
    await screen.findByText(/umbral_fraude/);
    expect(screen.queryByText(/otra/)).toBeNull();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('"yes, it holds" answers and moves straight to the next card', async () => {
    const decideCuration = vi.fn().mockResolvedValue({ ok: true, noteId: 'n1' });
    const api = apiWith({
      decideCuration,
      curationBatch: vi.fn().mockResolvedValue([card(), card({ id: 'c2', citation: 'segunda' })]),
    });
    renderWithCtx(<ReviewView />, { api, spaceId: 's1' });
    await screen.findByText(/umbral_fraude/);
    await userEvent.click(screen.getByRole('button', { name: /Yes, it holds/i }));
    await waitFor(() => expect(decideCuration).toHaveBeenCalledWith('c1', 'confirmed', undefined));
    expect(await screen.findByText(/segunda/)).toBeInTheDocument();
  });

  it('rejecting demands a reason before it can be sent', async () => {
    const decideCuration = vi.fn().mockResolvedValue({ ok: true, noteId: 'n1' });
    renderWithCtx(<ReviewView />, { api: apiWith({ decideCuration }), spaceId: 's1' });
    await screen.findByText(/umbral_fraude/);
    await userEvent.click(screen.getByRole('button', { name: /Reject…/i }));

    // An owner must not be able to drop something in silence.
    expect(screen.getByRole('button', { name: /^Reject$/i })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Why \(recorded and appealable\)/i), 'duplicada');
    await userEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    await waitFor(() =>
      expect(decideCuration).toHaveBeenCalledWith('c1', 'rejected', 'duplicada'),
    );
  });

  it('an empty batch offers to build one', async () => {
    const buildCurationBatch = vi.fn().mockResolvedValue({ built: 3, budget: 10 });
    const api = apiWith({ curationBatch: vi.fn().mockResolvedValue([]), buildCurationBatch });
    renderWithCtx(<ReviewView />, { api, spaceId: 's1' });
    await screen.findByText(/Nothing to review/i);
    await userEvent.click(screen.getByRole('button', { name: /Build this week/i }));
    await waitFor(() => expect(buildCurationBatch).toHaveBeenCalledWith('s1'));
  });

  it('clicking the title opens the note behind the question', async () => {
    const openNote = vi.fn();
    renderWithCtx(<ReviewView />, { api: apiWith({}), spaceId: 's1', openNote });
    await userEvent.click(await screen.findByRole('button', { name: /Acta de riesgo/ }));
    expect(openNote).toHaveBeenCalledWith('n1');
  });
});
