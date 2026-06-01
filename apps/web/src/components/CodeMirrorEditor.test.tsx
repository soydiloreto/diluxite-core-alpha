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
