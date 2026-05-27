import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ContextMenuItem {
  /** Visible label. */
  label: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Optional trailing hint (e.g. shortcut). */
  hint?: string;
  /** Click handler. The menu closes automatically before this runs. */
  onSelect: () => void;
  /** Render in danger color (e.g. Delete). */
  danger?: boolean;
  /** Disabled — still shown but not clickable. */
  disabled?: boolean;
}

export type ContextMenuEntry = ContextMenuItem | 'separator';

interface State {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

/**
 * Imperative context-menu hook. Returns:
 *  - `bind(entriesFactory)` → handler suitable for `onContextMenu` on any
 *    element. Lazily computes the entries with the cursor position.
 *  - `<Menu />` → renders the floating menu (mount once at app root).
 *  - `close()` → close programmatically.
 */
export function useContextMenu() {
  const [state, setState] = useState<State | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setState(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setState(null);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [state]);

  function open(e: React.MouseEvent, entries: ContextMenuEntry[]) {
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, entries });
  }

  function close() {
    setState(null);
  }

  function Menu() {
    if (!state) return null;
    return (
      <div
        ref={ref}
        role="menu"
        data-testid="context-menu"
        style={{ left: state.x, top: state.y }}
        className="fixed z-50 min-w-[180px] max-w-xs rounded-md border border-line bg-bg-surface shadow-2xl py-1 text-sm"
      >
        {state.entries.map((entry, i) => {
          if (entry === 'separator') return <div key={i} className="my-1 h-px bg-line" />;
          return (
            <button
              key={i}
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                close();
                entry.onSelect();
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                entry.disabled
                  ? 'text-ink-muted cursor-not-allowed'
                  : entry.danger
                    ? 'text-red-400 hover:bg-red-500/10'
                    : 'text-ink hover:bg-bg'
              }`}
            >
              {entry.icon && <span className="shrink-0">{entry.icon}</span>}
              <span className="flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="text-[11px] text-ink-muted">{entry.hint}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  return { open, close, Menu };
}
