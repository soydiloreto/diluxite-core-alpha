import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
 *  - `open(event, entries)` → call from `onContextMenu` (or `onClick`) to
 *    spawn the menu at the cursor.
 *  - `<Menu />` → renders the floating menu (mount once at app root).
 *  - `close()` → close programmatically.
 *
 * Keyboard model (matches OS menus):
 *  - ArrowDown / ArrowUp move the highlight, skipping separators and
 *    disabled items, wrapping at the ends.
 *  - Home / End jump to first / last enabled item.
 *  - Enter / Space activate the highlighted item.
 *  - Escape closes without selecting.
 *  - Tab is consumed (we don't move focus out — the menu is modal-ish).
 */
export function useContextMenu() {
  const [state, setState] = useState<State | null>(null);
  const [highlight, setHighlight] = useState<number>(-1);
  const ref = useRef<HTMLDivElement>(null);

  // Indices of the entries that can actually receive focus (i.e. menu
  // items that aren't disabled). Used for arrow nav so we skip
  // separators / disabled in one hop.
  const enabledIdxs = useMemo(() => {
    if (!state) return [] as number[];
    const out: number[] = [];
    state.entries.forEach((e, i) => {
      if (e !== 'separator' && !e.disabled) out.push(i);
    });
    return out;
  }, [state]);

  // Reset the highlight whenever a new menu opens.
  useEffect(() => {
    if (state) setHighlight(enabledIdxs[0] ?? -1);
    else setHighlight(-1);
  }, [state, enabledIdxs]);

  useEffect(() => {
    if (!state) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setState(null);
    }
    function moveTo(targetEnabledIdx: number) {
      if (enabledIdxs.length === 0) return;
      const wrapped = (targetEnabledIdx + enabledIdxs.length) % enabledIdxs.length;
      setHighlight(enabledIdxs[wrapped]);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setState(null);
        return;
      }
      if (enabledIdxs.length === 0) return;
      const currentEnabledIdx = enabledIdxs.indexOf(highlight);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveTo(currentEnabledIdx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveTo(currentEnabledIdx === -1 ? enabledIdxs.length - 1 : currentEnabledIdx - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        moveTo(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        moveTo(enabledIdxs.length - 1);
      } else if (e.key === 'Tab') {
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === ' ') {
        const entry = state?.entries[highlight];
        if (entry && entry !== 'separator' && !entry.disabled) {
          e.preventDefault();
          setState(null);
          entry.onSelect();
        }
      }
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, highlight, enabledIdxs]);

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
          const isHighlighted = i === highlight && !entry.disabled;
          return (
            <button
              key={i}
              role="menuitem"
              disabled={entry.disabled}
              data-highlighted={isHighlighted ? 'true' : undefined}
              onMouseEnter={() => {
                if (!entry.disabled) setHighlight(i);
              }}
              onClick={() => {
                close();
                entry.onSelect();
              }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                entry.disabled
                  ? 'text-ink-muted cursor-not-allowed'
                  : entry.danger
                    ? `text-red-400 ${isHighlighted ? 'bg-red-500/15' : 'hover:bg-red-500/10'}`
                    : `text-ink ${isHighlighted ? 'bg-bg' : 'hover:bg-bg'}`
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
