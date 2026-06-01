import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers as lineNumbersExt } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { yCollab } from 'y-codemirror.next';
import { useSettings } from '../useSettings';

/**
 * CodeMirror 6 markdown editor with optional Yjs collaboration.
 *
 * Two modes
 * ─────────
 *
 *  1. **Plain mode** (legacy): pass `value` + `onChange`. The editor is a
 *     controlled component; we mirror `value` into the doc when it changes
 *     from the outside, and emit `onChange(text)` on every doc transaction.
 *     This is the drop-in replacement for the old MonacoMarkdown contract.
 *
 *  2. **Collab mode**: pass `collab={ url, docName, userName, userColor }`.
 *     The editor opens a HocuspocusProvider, binds the shared Y.Text as the
 *     source of truth, and lets the server hydrate the initial content. In
 *     this mode `value` is ignored (Hocuspocus is the source of truth) and
 *     `onChange` fires with the post-edit text so the surrounding UI can
 *     re-render the markdown preview.
 *
 * `onBlur` is honored in both modes — NotePanel uses it as a "flush my
 * draft" hook for the legacy autosave-on-blur model. With collab on, the
 * server is already persisting every keystroke through onStoreDocument, so
 * onBlur is just a UX hint that we mirror through anyway.
 *
 * Why CodeMirror 6 over Monaco
 * ────────────────────────────
 *  - First-class Yjs binding via `y-codemirror.next` (Monaco's binding is
 *    notoriously flaky).
 *  - 40× lighter bundle than Monaco. The 4.5MB chunk goes away.
 *  - Theme + extensions are plain values, not "options" — easier to test.
 *  - Native mobile selection is more reliable.
 */

export type CodeMirrorEditorCollabConfig = {
  /** ws:// or wss:// endpoint where Hocuspocus is listening. */
  url: string;
  /** Document name — by convention `note:<uuid>` (see collab.ts). */
  docName: string;
  /** Optional display name for awareness/cursor labels. */
  userName?: string;
  /** Optional CSS color for this user's caret + selection. */
  userColor?: string;
  /** Optional bearer token sent to the server's onAuthenticate hook. */
  token?: string;
};

export function CodeMirrorEditor({
  value,
  onChange,
  onBlur,
  collab,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  collab?: CodeMirrorEditorCollabConfig;
}) {
  const { prefs } = useSettings();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());

  // Refs that bypass the React closure trap in CodeMirror callbacks.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const collabRef = useRef(collab);
  collabRef.current = collab;

  // ─── Mount: build the editor once. We deliberately don't include `collab`
  //         in the deps to avoid tearing down on every parent re-render —
  //         changes to `collab` are reflected by a separate effect that
  //         rebuilds the view when the docName changes.
  useEffect(() => {
    if (!hostRef.current) return;

    let provider: HocuspocusProvider | null = null;
    let providerWs: HocuspocusProviderWebsocket | null = null;
    let yDoc: Y.Doc | null = null;
    const isCollab = !!collabRef.current;

    const extensions = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      themeCompartment.current.of(prefs.theme === 'light' ? [] : oneDark),
      lineNumbersExt(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
      EditorView.domEventHandlers({
        blur: () => {
          onBlurRef.current?.();
          return false;
        },
      }),
    ];

    if (isCollab && collabRef.current) {
      yDoc = new Y.Doc();
      providerWs = new HocuspocusProviderWebsocket({ url: collabRef.current.url });
      provider = new HocuspocusProvider({
        websocketProvider: providerWs,
        name: collabRef.current.docName,
        document: yDoc,
        token: collabRef.current.token,
      });
      const yText = yDoc.getText('markdown');
      // Local user metadata for awareness — Sprint 3 renders remote cursors.
      if (collabRef.current.userName) {
        provider.awareness?.setLocalStateField('user', {
          name: collabRef.current.userName,
          color: collabRef.current.userColor ?? '#16a34a',
        });
      }
      extensions.push(yCollab(yText, provider.awareness));
    }

    const state = EditorState.create({
      doc: isCollab ? '' : value,
      extensions,
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      provider?.destroy();
      providerWs?.destroy();
      yDoc?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab?.docName, collab?.url]);

  // ─── Theme: hot-swap via Compartment instead of rebuilding the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        prefs.theme === 'light' ? [] : oneDark,
      ),
    });
  }, [prefs.theme]);

  // ─── Plain mode only: sync external `value` changes into the editor.
  //         In collab mode the server is the source of truth; the parent
  //         should not be feeding `value` back in.
  useEffect(() => {
    if (collab) return;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value, collab]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full overflow-auto bg-bg text-ink cm-host"
      data-testid="codemirror-editor"
    />
  );
}
