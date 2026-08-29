import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { NotesTree } from './NotesTree';
import type { Folder, Note } from '../api';

const note = (id: string, title: string, folderId: string | null = null): Note =>
  ({ id, title, folderId, spaceId: 's', contentMd: '' }) as Note;
const folder = (id: string, name: string, parentId: string | null = null): Folder =>
  ({ id, name, parentId, spaceId: 's' }) as Folder;

function setup() {
  const onOpen = vi.fn();
  const onMoveItems = vi.fn();
  const onDeleteItems = vi.fn();
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
      onDeleteItems={onDeleteItems}
    />,
  );
  return { onOpen, onMoveItems, onDeleteItems };
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

  it('Ctrl+primary click toggles the row instead of opening the menu (macOS)', () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    onOpen.mockClear();

    fireEvent.contextMenu(rowOf('Gamma'), { ctrlKey: true, button: 0 });

    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Gamma')).toBe(true);
  });

  it('a real right-click still opens the context menu', () => {
    setup();
    fireEvent.contextMenu(rowOf('Gamma'), { ctrlKey: true, button: 2 });
    expect(screen.getByRole('menuitem', { name: /Move to/ })).toBeTruthy();
  });

  it('clicking the row outside the label selects it too', () => {
    const { onOpen } = setup();
    fireEvent.click(rowOf('Beta'), { shiftKey: false });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(isSelected('Beta')).toBe(true);
  });

  it('dragging a multi-selection uses a ghost labelled with the count', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }), { metaKey: true });

    const setDragImage = vi.fn();
    const dataTransfer = {
      setData: vi.fn(),
      setDragImage,
      effectAllowed: '',
    };
    fireEvent.dragStart(rowOf('Gamma'), { dataTransfer });

    expect(setDragImage).toHaveBeenCalledTimes(1);
    expect((setDragImage.mock.calls[0][0] as HTMLElement).textContent).toBe('2 items');
    const payload = JSON.parse(dataTransfer.setData.mock.calls[0][1] as string);
    expect(payload).toHaveLength(2);
  });

  it('dragging a single row keeps the native ghost', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    const setDragImage = vi.fn();
    fireEvent.dragStart(rowOf('Alpha'), {
      dataTransfer: { setData: vi.fn(), setDragImage, effectAllowed: '' },
    });

    expect(setDragImage).not.toHaveBeenCalled();
  });

  it('dropping on a note inside a folder lands in THAT folder, not root', () => {
    const onMoveItems = vi.fn();
    render(
      <NotesTree
        folders={[folder('f1', 'Work')]}
        notes={[note('n1', 'Alpha'), note('n4', 'Delta', 'f1')]}
        currentId={null}
        onOpen={vi.fn()}
        onCreateFolder={() => {}}
        onCreateNote={() => {}}
        onMoveItems={onMoveItems}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'expand' }));

    const payload = JSON.stringify([{ kind: 'note', id: 'n1' }]);
    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => payload,
      dropEffect: '',
    };
    const sibling = rowOf('Delta');
    fireEvent.dragOver(sibling, { dataTransfer });
    fireEvent.drop(sibling, { dataTransfer });

    expect(onMoveItems).toHaveBeenCalledWith('f1', ['n1'], []);
  });

  it('dropping on a root-level note still means root', () => {
    const { onMoveItems } = setup();

    const payload = JSON.stringify([{ kind: 'note', id: 'n1' }]);
    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => payload,
      dropEffect: '',
    };
    fireEvent.dragOver(rowOf('Beta'), { dataTransfer });
    fireEvent.drop(rowOf('Beta'), { dataTransfer });

    expect(onMoveItems).toHaveBeenCalledWith(null, ['n1'], []);
  });

  it('the selected row carries the accent styling, not just aria-selected', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    // jsdom resolves no Tailwind, so this asserts the classes are applied —
    // the painted contrast itself is not observable here.
    const cls = rowOf('Alpha').className;
    expect(cls).toContain('bg-brand/30');
    expect(cls).toContain('shadow-[inset_2px_0_0_0_var(--c-brand)]');
    expect(rowOf('Beta').className).not.toContain('bg-brand/30');
  });

  it('shows an accent drop line on the row being hovered while dragging', () => {
    setup();
    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
      dropEffect: '',
    };

    expect(screen.queryAllByTestId('drop-line')).toHaveLength(0);

    fireEvent.dragOver(rowOf('Beta'), { dataTransfer });
    const line = screen.getAllByTestId('drop-line');
    expect(line).toHaveLength(1);
    expect(rowOf('Beta').contains(line[0])).toBe(true);

    // A folder is a container, not a position: it paints instead of ruling.
    fireEvent.dragOver(rowOf('Work'), { dataTransfer });
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(0);
    expect(rowOf('Work').className).toContain('ring-brand');

    fireEvent.drop(rowOf('Work'), { dataTransfer });
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(0);
  });

  it('a drag that leaves the row takes the drop line with it', () => {
    setup();
    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
      dropEffect: '',
    };
    fireEvent.dragOver(rowOf('Beta'), { dataTransfer });
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(1);

    fireEvent.dragLeave(rowOf('Beta'), { dataTransfer });
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(0);
  });

  it('after a drop the moved items stay selected in the destination', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { metaKey: true });

    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () =>
        JSON.stringify([
          { kind: 'note', id: 'n1' },
          { kind: 'note', id: 'n2' },
        ]),
      dropEffect: '',
    };
    fireEvent.drop(rowOf('Work'), { dataTransfer });

    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(true);
    // The destination is expanded so the moved rows are on screen, not hidden.
    expect(screen.getByRole('button', { name: 'collapse' })).toBeTruthy();
  });

  it('Shift-click right after a move extends from what was moved', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
      dropEffect: '',
    };
    fireEvent.drop(rowOf('Work'), { dataTransfer });

    // Without an anchor this used to collapse to a single row — the bug where
    // Shift behaved like Cmd after moving a group.
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }), { shiftKey: true });

    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(true);
    expect(isSelected('Gamma')).toBe(true);
  });

  it('every selected row paints the same accent, open note included', () => {
    const onOpen = vi.fn();
    render(
      <NotesTree
        folders={[]}
        notes={[note('n1', 'Alpha'), note('n2', 'Beta')]}
        currentId="n1"
        onOpen={onOpen}
        onCreateFolder={() => {}}
        onCreateNote={() => {}}
        onMoveItems={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { shiftKey: true });

    // The open note used to keep the solid `bg-brand` fill, so a selection
    // that contained it showed two different colours.
    const open = rowOf('Alpha').className;
    const other = rowOf('Beta').className;
    expect(open).toContain('bg-brand/30');
    expect(open).not.toContain('bg-brand text-white');
    expect(other).toContain('bg-brand/30');
    expect(open).toContain('ring-brand');
  });

  it('on a fresh load Shift extends from the open note', () => {
    render(
      <NotesTree
        folders={[]}
        notes={[note('n1', 'Alpha'), note('n2', 'Beta'), note('n3', 'Gamma')]}
        currentId="n1"
        onOpen={vi.fn()}
        onCreateFolder={() => {}}
        onCreateNote={() => {}}
        onMoveItems={vi.fn()}
      />,
    );

    // No click yet: the only thing on screen is the open note's highlight.
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }), { shiftKey: true });

    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(true);
    expect(isSelected('Gamma')).toBe(true);
  });

  it('after clearing, Shift starts from the open note again', () => {
    render(
      <NotesTree
        folders={[]}
        notes={[note('n1', 'Alpha'), note('n2', 'Beta'), note('n3', 'Gamma')]}
        currentId="n1"
        onOpen={vi.fn()}
        onCreateFolder={() => {}}
        onCreateNote={() => {}}
        onMoveItems={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { shiftKey: true });

    expect(isSelected('Alpha')).toBe(true);
    expect(isSelected('Beta')).toBe(true);
    expect(isSelected('Gamma')).toBe(false);
  });

  it('hovering a closed folder with a payload springs it open after a dwell', () => {
    vi.useFakeTimers();
    try {
      setup();
      const dataTransfer = {
        types: ['application/x-diluxite'],
        getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
        dropEffect: '',
      };
      expect(screen.getByRole('button', { name: 'expand' })).toBeTruthy();

      fireEvent.dragOver(rowOf('Work'), { dataTransfer });
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('button', { name: 'expand' })).toBeTruthy();

      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByRole('button', { name: 'collapse' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaving the folder before the dwell keeps it closed', () => {
    vi.useFakeTimers();
    try {
      setup();
      const dataTransfer = {
        types: ['application/x-diluxite'],
        getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
        dropEffect: '',
      };
      fireEvent.dragOver(rowOf('Work'), { dataTransfer });
      act(() => vi.advanceTimersByTime(300));
      const leave = new MouseEvent('dragleave', { bubbles: true, cancelable: true });
      Object.defineProperty(leave, 'relatedTarget', { value: document.body });
      fireEvent(rowOf('Work'), leave);
      act(() => vi.advanceTimersByTime(1000));

      expect(screen.getByRole('button', { name: 'expand' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dragleave onto the row own children does not drop the target', () => {
    setup();
    const dataTransfer = {
      types: ['application/x-diluxite'],
      getData: () => JSON.stringify([{ kind: 'note', id: 'n1' }]),
      dropEffect: '',
    };
    const target = rowOf('Beta');
    fireEvent.dragOver(target, { dataTransfer });
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(1);

    // jsdom drops `relatedTarget` from a DragEvent init, so build the event.
    const leave = new MouseEvent('dragleave', { bubbles: true, cancelable: true });
    Object.defineProperty(leave, 'relatedTarget', { value: target.querySelector('button') });
    fireEvent(target, leave);
    expect(screen.queryAllByTestId('drop-line')).toHaveLength(1);
  });

  it('Delete removes the whole selection, notes and folders alike', () => {
    const { onDeleteItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }), { metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { metaKey: true });

    fireEvent.keyDown(document, { key: 'Delete' });

    expect(onDeleteItems).toHaveBeenCalledTimes(1);
    const [noteIds, folderIds] = onDeleteItems.mock.calls[0];
    expect(new Set(noteIds)).toEqual(new Set(['n1', 'n2']));
    expect(folderIds).toEqual(['f1']);
  });

  it('Backspace deletes too (the macOS delete key)', () => {
    const { onDeleteItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    fireEvent.keyDown(document, { key: 'Backspace' });

    expect(onDeleteItems).toHaveBeenCalledWith(['n1'], []);
  });

  it('Delete does nothing with an empty selection', () => {
    const { onDeleteItems } = setup();
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(onDeleteItems).not.toHaveBeenCalled();
  });

  it('Delete while typing is left to the input', () => {
    const { onDeleteItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'Delete' });
    input.remove();

    expect(onDeleteItems).not.toHaveBeenCalled();
  });

  it('Delete belongs to whatever has the focus, not to the tree', () => {
    // The selection outlives the click that made it, and this listener is
    // document-wide, so it used to fire from anywhere. On a dockview tab
    // Delete already means "close this tab" — and both ran: the tab closed
    // and "Delete 1 item?" appeared behind it.
    const { onDeleteItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: 'Delete' });
    expect(onDeleteItems).not.toHaveBeenCalled();

    // ...and it still fires when the focus is back on the tree itself.
    elsewhere.remove();
    screen.getByRole('button', { name: 'Alpha' }).focus();
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(onDeleteItems).toHaveBeenCalledWith(['n1'], []);
  });

  it('the bulk context menu offers "Delete N items"', () => {
    const { onDeleteItems } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }), { metaKey: true });

    fireEvent.contextMenu(rowOf('Beta'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete 2 items/ }));

    expect(onDeleteItems).toHaveBeenCalledWith(expect.arrayContaining(['n1', 'n2']), []);
  });

  it('Escape clears the selection', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(isSelected('Alpha')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isSelected('Alpha')).toBe(false);
  });
});
