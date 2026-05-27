import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { useSettings } from '../useSettings';

/**
 * Thin wrapper around @monaco-editor/react tuned for note-taking:
 *  - markdown language
 *  - soft word-wrap
 *  - no minimap, slim line numbers
 *  - theme follows app prefs (oscuro → vs-dark, claro → vs)
 *  - debounced onChange + onBlur save hook
 *
 * Monaco loads from CDN by default via @monaco-editor/loader. That keeps the
 * dev bundle tiny and removes the worker plumbing we'd otherwise need in Vite.
 */
export function MonacoMarkdown({
  value,
  onChange,
  onBlur,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
}) {
  const { prefs } = useSettings();
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;

  const onMount: OnMount = (editor) => {
    editor.onDidBlurEditorText(() => blurRef.current?.());
  };

  useEffect(() => {
    // Nothing yet — placeholder for future theme tokens.
  }, []);

  return (
    <Editor
      language="markdown"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      theme={prefs.theme === 'claro' ? 'vs' : 'vs-dark'}
      options={{
        wordWrap: 'on',
        minimap: { enabled: false },
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        renderLineHighlight: 'none',
        scrollBeyondLastLine: false,
        fontSize: 14,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        padding: { top: 16, bottom: 16 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
      }}
    />
  );
}
