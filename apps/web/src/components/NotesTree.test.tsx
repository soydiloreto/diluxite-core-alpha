import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotesTree } from './NotesTree';
import type { Folder, Note } from '../api';

const note = (id: string, title: string, folderId: string | null = null): Note =>
  ({ id, title, folderId, spaceId: 's', contentMd: '' }) as Note;
const folder = (id: string, name: string, parentId: string | null = null): Folder =>
  ({ id, name, parentId, spaceId: 's' }) as Folder;

function setup() {
  const onOpen = vi.fn();
  const onMoveItems = vi.fn();
  const notes = [note('n1', 'Alpha'), note('n2', 'Beta'), note('n3', 'Gamma')];
  const folders = [folder('f1', 'Work')];
  render(
    <NotesTree
      folders={folders}
      notes={notes}
      currentId={null}
      onOpen={onOpen}
      onCreateFolder={() => {}}
      onCreateNote={() => {}}
      onMoveItems={onMoveItems}
    />,
  );
  return { onOpen, onMoveItems };
}

const rowOf = (name: string) =>
  screen.getByRole('button', { name }).closest('.group') as HTMLElement;
const isSelected = (name: string) => rowOf(name).getAttribute('aria-selected') === 'true';

describe('NotesTree multi-select', () => {
  it('plain click opens the note and selects only it', () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(false);
  });

  it('Cmd/Ctrl-click adds rows to the selection without opening', () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    onOpen.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }), { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Gamma')).toBe(true);
    expect(isSelected('Beta')).toBe(false);
  });

  it('Cmd/Ctrl-click again deselects a row', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }), { ctrlKey: true });
    expect(isSelected('Alpha')).toBe(false);
  });

  it('Shift-click selects the contiguous range from the anchor', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' })); // anchor
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }), { shiftKey: true });
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(true);
    expect(isSelected('Gamma')).toBe(true);
  });

  it('moves the whole selection via the "Move N items to…" context menu', () => {
    const { onMoveItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { metaKey: true });

    // Right-click a selected row → bulk menu.
    fireEvent.contextMenu(rowOf('Beta'));
    const moveItem = screen.getByRole('menuitem', { name: /Move 2 items to/ });
    fireEvent.click(moveItem);

    // Picker opens; default destination is root → confirm.
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));

    expect(onMoveItems).toHaveBeenCalledTimes(1);
    const [target, noteIds, folderIds] = onMoveItems.mock.calls[0];
    expect(target).toBeNull();
    expect(new Set(noteIds)).toEqual(new Set(['n1', 'n2']));
    expect(folderIds).toEqual([]);
  });

  it('moves into a chosen folder from the picker', () => {
    const { onMoveItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    fireEvent.contextMenu(rowOf('Gamma'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Move to/ }));

    fireEvent.change(screen.getByLabelText('destination folder'), { target: { value: 'f1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));

    expect(onMoveItems).toHaveBeenCalledWith('f1', ['n3'], []);
  });

  it('Escape clears the selection', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(isSelected('Alpha')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isSelected('Alpha')).toBe(false);
  });
});
