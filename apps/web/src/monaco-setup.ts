/**
 * Bundle Monaco locally (instead of the default CDN loader) so the editor
 * renders reliably without external network access. Vite's `?worker` imports
 * resolve to real Web Workers at build time.
 */
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// Tell Monaco how to spin up its workers. We only need the base editor worker
// for markdown / plain languages; the language-specific workers (json, ts,
// html, css) are not registered, which keeps the bundle small.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });
