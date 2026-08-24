import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { renderWithCtx, makeNote } from '../../test/render-with-ctx';

const noop = () => {};

function renderSidebar(currentNoteId: string | null, notes = [makeNote()]) {
  return renderWithCtx(
    <Sidebar
      currentNoteId={currentNoteId}
      onCreateNote={noop}
      onCreateFolder={noop}
      onRenameFolder={noop}
      onDeleteFolder={noop}
      onDeleteNote={noop}
      onRenameNote={noop}
      onToggleFavorite={noop}
      onMoveNoteToFolder={noop}
      onMoveFolderToFolder={noop}
      onMoveItems={noop}
      onDeleteItems={noop}
    />,
    { notes },
  );
}

describe('Sidebar', () => {
  it('marks the note named by currentNoteId as active (prop-driven, not window.location)', () => {
    // Regression: the active row used to be derived from
    // `window.location.pathname` read during render. In jsdom that path is "/",
    // so nothing would ever be active. Driving it from the `currentNoteId`
    // prop makes the highlight deterministic and testable.
    const a = makeNote({ title: 'Alpha' });
    const b = makeNote({ title: 'Beta' });
    renderSidebar(b.id, [a, b]);

    // TreeRow applies `bg-brand` to the active row's wrapper.
    const activeBtn = screen.getByRole('button', { name: 'Beta' });
    const inactiveBtn = screen.getByRole('button', { name: 'Alpha' });
    expect(activeBtn.closest('.bg-brand')).not.toBeNull();
    expect(inactiveBtn.closest('.bg-brand')).toBeNull();
  });

  it('marks nothing active when currentNoteId is null', () => {
    const a = makeNote({ title: 'Alpha' });
    renderSidebar(null, [a]);
    expect(screen.getByRole('button', { name: 'Alpha' }).closest('.bg-brand')).toBeNull();
  });
});
