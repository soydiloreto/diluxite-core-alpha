import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers as lineNumbersExt } from '@codemirror/view';
import { WebSocketStatus } from '@hocuspocus/provider';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { useSettings } from '../useSettings';
import type { PresenceUser } from './PresenceAvatars';
import { userColorTokens } from './userColor';

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
  /** Local user shown to other clients in awareness (cursor label + avatar). */
  user?: { identity: string; name: string };
  /** Optional bearer token sent to the server's onAuthenticate hook. */
  token?: string;
};

/**
 * Public connection status — what the parent renders the banner from.
 *
 *  - connecting/connected/disconnected: regular WS lifecycle.
 *  - auth-expired: the server rejected our handshake (typically session
 *    cookie expired mid-session). Distinct from `disconnected` because the
 *    fix is "refresh + log in again", not "wait for network to come back".
 */
export type CollabConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'auth-expired';

export function CodeMirrorEditor({
  value,
  onChange,
  onBlur,
  collab,
  onPresenceChange,
  onConnectionChange,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  collab?: CodeMirrorEditorCollabConfig;
  /** Fired with the full presence roster (self included) whenever it changes. */
  onPresenceChange?: (users: PresenceUser[]) => void;
  /**
   * Fired with the WebSocket status. Only useful in collab mode. The parent
   * is expected to render a banner + a hint to the user when the editor goes
   * read-only on disconnect.
   */
  onConnectionChange?: (status: CollabConnectionStatus) => void;
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
  const onPresenceRef = useRef(onPresenceChange);
  onPresenceRef.current = onPresenceChange;
  const onConnectionRef = useRef(onConnectionChange);
  onConnectionRef.current = onConnectionChange;
  // Editable compartment lets us toggle read-only when the WS drops without
  // tearing the editor down.
  const editableCompartment = useRef(new Compartment());

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

    // Undo/redo source differs by mode. In collab mode the CodeMirror
    // `history()` would undo *remote* edits too (it tracks every doc change,
    // not just ours), so we drop it and lean on the Y.UndoManager that
    // `yCollab(...)` wires up below — it only tracks the local origin — plus
    // its `yUndoManagerKeymap` for Ctrl/Cmd+Z. In single-user mode the plain
    // CodeMirror history is correct.
    const historyExtensions = isCollab
      ? [keymap.of([...defaultKeymap, ...yUndoManagerKeymap])]
      : [history(), keymap.of([...defaultKeymap, ...historyKeymap])];

    const extensions = [
      ...historyExtensions,
      markdown(),
      EditorView.lineWrapping,
      // CodeMirror marks its content div `role="textbox"` but has no name to
      // give it: the label would normally come from the surrounding form,
      // and there isn't one. Without this, a screen reader announces the note
      // body as an unlabelled edit field (`aria-input-field-name`, serious).
      EditorView.contentAttributes.of({ 'aria-label': 'Note content, markdown' }),
      themeCompartment.current.of(prefs.theme === 'light' ? [] : oneDark),
      editableCompartment.current.of(EditorView.editable.of(true)),
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
      // Awareness: local user metadata so other clients render our cursor +
      // avatar with our name and a stable color. The same color tokens drive
      // the PresenceAvatars chip in the note header.
      const local = collabRef.current.user;
      if (local && provider.awareness) {
        const tokens = userColorTokens(local.identity);
        provider.awareness.setLocalStateField('user', {
          identity: local.identity,
          name: local.name,
          color: tokens.caret,
          colorLight: tokens.selection,
        });
      }
      extensions.push(yCollab(yText, provider.awareness));

      // Connection status → emit to parent + toggle editor read-only on drop.
      const emitStatus = (raw: WebSocketStatus) => {
        const status: CollabConnectionStatus =
          raw === WebSocketStatus.Connected
            ? 'connected'
            : raw === WebSocketStatus.Connecting
              ? 'connecting'
              : 'disconnected';
        onConnectionRef.current?.(status);
        // No offline edits — strip the editable extension if we lost the WS.
        const view = viewRef.current;
        if (view) {
          view.dispatch({
            effects: editableCompartment.current.reconfigure(
              EditorView.editable.of(status === 'connected'),
            ),
          });
        }
      };
      providerWs.on('status', (e: { status: WebSocketStatus }) => emitStatus(e.status));
      // Auth rejection on (re)connect — handshake failed because the session
      // cookie expired. The provider keeps retrying with the same cookie and
      // never succeeds, so we treat this as a terminal state from the UI's
      // perspective and surface the dedicated banner.
      provider.on('authenticationFailed', () => {
        onConnectionRef.current?.('auth-expired');
        const view = viewRef.current;
        if (view) {
          view.dispatch({
            effects: editableCompartment.current.reconfigure(
              EditorView.editable.of(false),
            ),
          });
        }
      });
      // Initial state — providerWs starts in `Connecting`.
      onConnectionRef.current?.('connecting');

      // Subscribe to roster changes. yjs awareness emits 'change' with the
      // updated clientID list; we materialize the full state map into the
      // shape PresenceAvatars expects. Local user is folded in via the
      // clientID === awareness.clientID check.
      const awareness = provider.awareness;
      if (awareness) {
        const localId = awareness.clientID;
        const emit = () => {
          const cb = onPresenceRef.current;
          if (!cb) return;
          const states = Array.from(awareness.getStates().entries());
          // Imperative push instead of map+filter so the type stays
          // PresenceUser[] without TS choking on the inferred
          // (PresenceUser | null)[] from map. Same result, cheaper to type.
          const users: PresenceUser[] = [];
          for (const [clientId, st] of states) {
            const u = (st as { user?: { identity?: string; name?: string } }).user;
            if (!u?.identity || !u.name) continue;
            users.push({
              identity: u.identity,
              name: u.name,
              isSelf: clientId === localId,
            });
          }
          // Self goes first so the chip order is "you, then guests".
          users.sort((a, b) => Number(b.isSelf ?? false) - Number(a.isSelf ?? false));
          cb(users);
        };
        awareness.on('change', emit);
        // Emit once after mount so the consumer renders the initial roster
        // (which already includes "us").
        setTimeout(emit, 0);
      }
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
    // Deps intentionally minimal: we want the editor to rebuild only when
    // the collab target (docName/url) changes, not when other props update.
    // `collab.user` and the callbacks reach into refs above so the effect
    // can stay stable across renders.
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
