import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { NotePanel } from './NotePanel';
import { buildCtx, makeNote } from '../../../test/render-with-ctx';
import { DialogProvider } from '../../ui';
import { AppProvider } from '../AppContext';
import type { Note } from '../../api';
import type { ApiClient } from '../../api';
import type { IDockviewPanelProps } from 'dockview-react';

// jsdom doesn't implement CodeMirror's measurement APIs; silence the warning.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  localStorage.clear();
});

// Minimal stub of the dockview panel props NotePanel actually touches.
function makeProps(noteId: string): IDockviewPanelProps<{ noteId: string }> {
  return {
    params: { noteId },
    api: { setTitle: vi.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// NotePanel eagerly loads backlinks/related — give it a resolving stub.
const listVersions = vi.fn(async (): Promise<unknown[]> => []);
const getVersion = vi.fn(async () => ({
  id: 'v1',
  noteId: 'n1',
  spaceId: 's1',
  title: 'T',
  contentMd: 'lo que decía antes',
  createdAt: new Date(0).toISOString(),
}));
const restoreVersion = vi.fn(async () => ({ id: 'n1' }));
const api = {
  backlinks: vi.fn(async () => []),
  related: vi.fn(async () => []),
  listVersions,
  getVersion,
  restoreVersion,
} as unknown as ApiClient;

function renderPanel(notes: Note[], extra: Record<string, unknown> = {}) {
  const props = makeProps(notes[0].id);
  function Tree({ notes }: { notes: Note[] }) {
    return (
      <DialogProvider>
        <AppProvider value={buildCtx({ notes, api, ...extra })}>
          <NotePanel {...props} />
        </AppProvider>
      </DialogProvider>
    );
  }
  const utils = render(<Tree notes={notes} />);
  return { ...utils, Tree };
}

/** Every note opens in the reading view — flip to the raw editor first. */
function enterEditMode() {
  fireEvent.click(screen.getByLabelText('edit raw markdown'));
}

/** Type `text` at the end of the editor's doc through a real CM transaction so
 *  the updateListener fires onChange (and NotePanel's draft updates). */
function typeIntoEditor(text: string) {
  const host = screen.getByTestId('codemirror-editor');
  const view = EditorView.findFromDOM(host as HTMLElement);
  if (!view) throw new Error('EditorView not found');
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  });
}

describe('NotePanel — draft preservation', () => {
  it('does not clobber unsaved keystrokes when a stale save response updates contentMd', () => {
    // Scenario: user types → blur fires a save → user keeps typing → the save
    // response arrives and global note.contentMd updates to the just-saved
    // (now stale) text. The local draft has newer keystrokes and must win.
    const note = makeNote({ id: 'n1', title: 'T', contentMd: 'hello' });
    const { rerender, Tree } = renderPanel([note]);
    enterEditMode();

    const host = screen.getByTestId('codemirror-editor');
    expect(host.textContent ?? '').toContain('hello');

    // User types ' world' (blur would now fire save('hello world')), then
    // keeps typing '!' while that save is still in flight → draft is
    // "hello world!".
    typeIntoEditor(' world');
    typeIntoEditor('!');
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('hello world!');

    // The in-flight save lands: global contentMd becomes "hello world" (the
    // value at blur time — missing the trailing '!' typed afterwards).
    const saved = { ...note, contentMd: 'hello world' };
    rerender(<Tree notes={[saved]} />);

    // The editor must keep the newer local text incl. the '!', not roll back
    // to the just-saved "hello world".
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('hello world!');
  });

  it('adopts an external contentMd change when there are no local edits', () => {
    // No local typing → the draft is "clean", so an incoming contentMd (a
    // genuine remote/external edit) is adopted.
    const note = makeNote({ id: 'n1', title: 'T', contentMd: 'first' });
    const { rerender, Tree } = renderPanel([note]);
    enterEditMode();
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('first');

    const external = { ...note, contentMd: 'second' };
    rerender(<Tree notes={[external]} />);
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('second');
  });

  it('reseeds the draft when switching to a different note id', () => {
    const a = makeNote({ id: 'na', title: 'A', contentMd: 'alpha' });
    expect(a.id).toBe('na');
    renderPanel([a]);
    enterEditMode();
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('alpha');
  });
});

describe('NotePanel — one body, one mode', () => {
  it('opens in the rendered reading view, with no editor mounted', () => {
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: '# Hola\n\nmundo' })]);
    expect(screen.getByTestId('preview').innerHTML).toContain('Hola');
    expect(screen.queryByTestId('codemirror-editor')).toBeNull();
  });

  it('the Code toggle switches to the raw editor and back — never both', async () => {
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })]);
    enterEditMode();
    expect(screen.getByTestId('codemirror-editor')).toBeTruthy();
    expect(screen.queryByTestId('preview')).toBeNull();

    fireEvent.click(screen.getByLabelText('show formatted view'));
    expect(await screen.findByTestId('preview')).toBeTruthy();
    expect(screen.queryByTestId('codemirror-editor')).toBeNull();
  });

  it('a brand-new empty note opens straight in the editor', () => {
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: '' })]);
    expect(screen.getByTestId('codemirror-editor')).toBeTruthy();
    expect(screen.queryByTestId('preview')).toBeNull();
  });
});

describe('NotePanel — version history', () => {
  it('the History button opens the modal; with no versions it says so honestly', async () => {
    listVersions.mockResolvedValueOnce([]);
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })]);
    fireEvent.click(screen.getByLabelText('note history'));
    expect(await screen.findByText(/no versions yet/i)).toBeTruthy();
    expect(listVersions).toHaveBeenCalledWith('n1');
  });

  it('lists snapshots and renders the selected one', async () => {
    listVersions.mockResolvedValueOnce([
      { id: 'v1', noteId: 'n1', spaceId: 's1', title: 'T', createdAt: new Date(0).toISOString() },
    ]);
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })]);
    fireEvent.click(screen.getByLabelText('note history'));
    const preview = await screen.findByTestId('history-preview');
    expect(preview.innerHTML).toContain('lo que decía antes');
    expect(getVersion).toHaveBeenCalledWith('n1', 'v1');
  });
});

describe('NotePanel — save state', () => {
  it('in the editor, a clean draft reads as saved and typing flips it to unsaved', async () => {
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })]);
    enterEditMode();
    expect(screen.getByTestId('save-state').textContent).toMatch(/saved/i);
    typeIntoEditor(' más');
    expect(screen.getByTestId('save-state').textContent).toMatch(/unsaved/i);
  });

  it('the reading view shows no save chatter', () => {
    renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })]);
    expect(screen.queryByTestId('save-state')).toBeNull();
  });
});

describe('NotePanel — smart autosave', () => {
  it('saves by itself ~4s after the last keystroke, no blur needed', async () => {
    vi.useFakeTimers();
    try {
      const saveNote = vi.fn(async () => undefined);
      renderPanel([makeNote({ id: 'n1', title: 'T', contentMd: 'algo' })], { saveNote });
      enterEditMode();
      typeIntoEditor(' más');
      expect(saveNote).not.toHaveBeenCalled(); // typing alone doesn't save
      await act(async () => {
        vi.advanceTimersByTime(4100);
      });
      expect(saveNote).toHaveBeenCalledWith('n1', 'algo más');
    } finally {
      vi.useRealTimers();
    }
  });
});
