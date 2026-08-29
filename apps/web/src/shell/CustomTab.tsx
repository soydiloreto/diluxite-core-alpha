import { useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { useContextMenu } from '../ui';

/** Dockview's own close glyph, so the tab keeps looking like every other one. */
function CloseGlyph() {
  return (
    <svg height="11" width="11" viewBox="0 0 28 28" aria-hidden="true" focusable="false" className="dv-svg">
      <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
    </svg>
  );
}

/** The panel title, kept live — dockview renames a tab when its note is renamed. */
function useTitle(api: IDockviewPanelHeaderProps['api']): string | undefined {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    setTitle(api.title);
    const d = api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [api]);
  return title;
}

/**
 * The tab strip: title, close affordance, and a right-click menu with the
 * usual VS Code actions (close one / others / to the right / all).
 *
 * WHY THIS RENDERS THE TAB BODY INSTEAD OF WRAPPING `DockviewDefaultTab`:
 * that component puts a real `<button>` inside the tab, and dockview marks
 * the tab itself `role="tab"` with `tabindex="0"`. A focusable control nested
 * inside another interactive control is `nested-interactive` — a serious axe
 * failure, and a real one: a screen reader lands on the tab and cannot
 * describe or reach what is inside it. Neither `tabindex="-1"` nor
 * `aria-hidden` fixes it, because a negative tabindex is still focusable.
 *
 * What is left is the WAI-ARIA Authoring Practices pattern for deletable
 * tabs: the ✕ is decorative (a span, hidden from assistive technology, there
 * for the mouse), and the keyboard path is Delete / Backspace on the tab —
 * which dockview's own tab strip already implements, roving focus to the
 * neighbouring tab included. Dockview's class names are reused too, so the
 * tab is styled and themed exactly as before.
 */
export function CustomTab(props: IDockviewPanelHeaderProps) {
  const menu = useContextMenu();
  const title = useTitle(props.api);

  function onContextMenu(e: React.MouseEvent) {
    const all = props.api.group.panels;
    const idx = all.findIndex((p) => p.id === props.api.id);
    if (idx < 0) return;
    menu.open(e, [
      { label: 'Close', onSelect: () => props.api.close() },
      {
        label: 'Close Others',
        disabled: all.length < 2,
        onSelect: () => {
          for (const p of [...all]) if (p.id !== props.api.id) p.api.close();
        },
      },
      {
        label: 'Close to the Right',
        disabled: idx >= all.length - 1,
        onSelect: () => {
          for (const p of all.slice(idx + 1)) p.api.close();
        },
      },
      'separator',
      {
        label: 'Close All',
        onSelect: () => {
          for (const p of [...all]) p.api.close();
        },
      },
    ]);
  }


  return (
    // Stamp the dockview panel id on the tab so document-level handlers (e.g.
    // middle-click-to-close in App) can resolve the exact panel. Titles aren't
    // unique across notes, so resolving by id is the only safe way.
    <div
      onContextMenu={onContextMenu}
      className="contents"
      data-panel-id={props.api.id}
    >
      <div data-testid="dockview-dv-default-tab" className="dv-default-tab">
        <span className="dv-default-tab-content">{title}</span>
        <span
          className="dv-default-tab-action"
          aria-hidden="true"
          // The tab owns the keyboard path; this is the pointer one, so it
          // must not swallow the pointerdown that starts a tab drag.
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            props.api.close();
          }}
        >
          <CloseGlyph />
        </span>
      </div>
      <menu.Menu />
    </div>
  );
}
