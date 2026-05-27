import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FavoritesView } from './FavoritesView';
import { renderWithCtx, makeNote } from '../../../test/render-with-ctx';

describe('FavoritesView', () => {
  it('shows an empty hint when nothing is favorited', () => {
    renderWithCtx(<FavoritesView />, { notes: [makeNote({ favorite: false })] });
    expect(screen.getByText(/Star a note/i)).toBeInTheDocument();
  });

  it('lists every favorite note and surfaces its title', () => {
    const a = makeNote({ title: 'Alpha', favorite: true });
    const b = makeNote({ title: 'Bravo', favorite: true });
    const c = makeNote({ title: 'Charlie', favorite: false });
    renderWithCtx(<FavoritesView />, { notes: [a, b, c] });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Bravo')).toBeInTheDocument();
    expect(screen.queryByText('Charlie')).toBeNull();
  });

  it('reports the count in the header', () => {
    renderWithCtx(<FavoritesView />, {
      notes: [
        makeNote({ favorite: true }),
        makeNote({ favorite: true }),
        makeNote({ favorite: false }),
      ],
    });
    // ViewShell renders the count right next to the title.
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking a row opens the note', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Alpha', favorite: true });
    renderWithCtx(<FavoritesView />, { notes: [a], openNote });
    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(openNote).toHaveBeenCalledWith(a.id);
  });

  it('uses a star icon for each favorite row', () => {
    const a = makeNote({ title: 'Alpha', favorite: true });
    renderWithCtx(<FavoritesView />, { notes: [a] });
    const row = screen.getByRole('button', { name: 'Alpha' });
    // Lucide renders icons as inline SVGs (no role by default); assert the
    // row leads with one.
    expect(row.querySelector('svg')).not.toBeNull();
  });
});
