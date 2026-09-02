import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArchiveView } from './ArchiveView';
import { renderWithCtx, makeNote } from '../../../test/render-with-ctx';

describe('ArchiveView', () => {
  it('shows an empty hint when nothing is archived', () => {
    renderWithCtx(<ArchiveView />, { notes: [makeNote({})] });
    expect(screen.getByText(/Archive a note/i)).toBeInTheDocument();
  });

  it('lists only archived notes', () => {
    const a = makeNote({ title: 'Alpha', archivedAt: '2026-09-01T10:00:00.000Z' });
    const b = makeNote({ title: 'Bravo' });
    renderWithCtx(<ArchiveView />, { notes: [a, b] });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Bravo')).toBeNull();
  });

  it('orders by when they were archived, newest first', () => {
    const older = makeNote({ title: 'Older', archivedAt: '2026-08-01T10:00:00.000Z' });
    const newer = makeNote({ title: 'Newer', archivedAt: '2026-09-01T10:00:00.000Z' });
    renderWithCtx(<ArchiveView />, { notes: [older, newer] });
    const titles = screen
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter((t) => t === 'Older' || t === 'Newer');
    expect(titles).toEqual(['Newer', 'Older']);
  });

  it('clicking a row opens the note', async () => {
    const user = userEvent.setup();
    const openNote = vi.fn();
    const a = makeNote({ title: 'Alpha', archivedAt: '2026-09-01T10:00:00.000Z' });
    renderWithCtx(<ArchiveView />, { notes: [a], openNote });
    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(openNote).toHaveBeenCalledWith(a.id);
  });

  it('the row action brings the note back', async () => {
    const user = userEvent.setup();
    const toggleArchive = vi.fn();
    const a = makeNote({ title: 'Alpha', archivedAt: '2026-09-01T10:00:00.000Z' });
    renderWithCtx(<ArchiveView />, { notes: [a], toggleArchive });
    await user.click(screen.getByRole('button', { name: 'unarchive Alpha' }));
    expect(toggleArchive).toHaveBeenCalledWith(a.id, false);
  });
});
