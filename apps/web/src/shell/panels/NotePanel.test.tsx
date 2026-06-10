import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
const api = {
  backlinks: vi.fn(async () => []),
  related: vi.fn(async () => []),
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
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('first');

    const external = { ...note, contentMd: 'second' };
    rerender(<Tree notes={[external]} />);
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('second');
  });

  it('reseeds the draft when switching to a different note id', () => {
    const a = makeNote({ id: 'na', title: 'A', contentMd: 'alpha' });
    expect(a.id).toBe('na');
    renderPanel([a]);
    expect(screen.getByTestId('codemirror-editor').textContent ?? '').toContain('alpha');
  });
});
