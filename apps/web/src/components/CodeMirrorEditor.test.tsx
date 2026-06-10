import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeMirrorEditor } from './CodeMirrorEditor';

// jsdom doesn't implement layout APIs CodeMirror queries on mount. The view
// still constructs and exposes `state.doc`; we test through the public API
// (props and the editor's textContent) rather than rendering pixel output.

describe('CodeMirrorEditor — plain (non-collab) mode', () => {
  beforeEach(() => {
    // Silence the CodeMirror warning about missing measurement APIs in jsdom.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('mounts and exposes its host element via testid', () => {
    render(<CodeMirrorEditor value="hola" onChange={() => undefined} />);
    expect(screen.getByTestId('codemirror-editor')).toBeInTheDocument();
  });

  it('renders the initial value in the editor', () => {
    render(<CodeMirrorEditor value="hola mundo" onChange={() => undefined} />);
    const host = screen.getByTestId('codemirror-editor');
    expect(host.textContent ?? '').toContain('hola mundo');
  });

  it('updates the visible text when the value prop changes', () => {
    const { rerender } = render(
      <CodeMirrorEditor value="primera" onChange={() => undefined} />,
    );
    const host = screen.getByTestId('codemirror-editor');
    expect(host.textContent ?? '').toContain('primera');

    rerender(<CodeMirrorEditor value="segunda" onChange={() => undefined} />);
    expect(host.textContent ?? '').toContain('segunda');
    expect(host.textContent ?? '').not.toContain('primera');
  });

  it('fires onBlur when the editor loses focus', () => {
    const onBlur = vi.fn();
    render(
      <CodeMirrorEditor value="x" onChange={() => undefined} onBlur={onBlur} />,
    );
    const host = screen.getByTestId('codemirror-editor');
    // CodeMirror mounts a contenteditable `.cm-content` inside the host. The
    // editor's domEventHandler listens on the editor view's content DOM, so
    // we fire the blur there.
    const content = host.querySelector('.cm-content');
    expect(content).toBeTruthy();
    fireEvent.blur(content!);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});

describe('CodeMirrorEditor — collab mode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Hocuspocus opens a WebSocket on mount. jsdom has none — hand it a stub
    // that never actually connects so the editor can build in both modes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = class {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {}
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    };
  });

  it('mounts in collab mode without crashing and uses the Yjs undo manager (no history())', () => {
    // The regression this guards: in collab mode the CodeMirror history()
    // extension would undo *remote* edits. We drop it for the y-codemirror
    // undo manager. We can't observe undo wiring directly in jsdom, but we
    // assert the editor builds + renders so the collab extension set (which
    // now includes yUndoManagerKeymap instead of history) is valid.
    render(
      <CodeMirrorEditor
        value=""
        onChange={() => undefined}
        collab={{
          url: 'ws://localhost:1234',
          docName: 'note:test',
          user: { identity: 'u1', name: 'Tester' },
        }}
      />,
    );
    expect(screen.getByTestId('codemirror-editor')).toBeInTheDocument();
    // The contenteditable surface is present → the EditorView constructed
    // with the collab extension list (defaultKeymap + yUndoManagerKeymap +
    // yCollab) rather than throwing on an invalid extension.
    const host = screen.getByTestId('codemirror-editor');
    expect(host.querySelector('.cm-content')).toBeTruthy();
  });
});
