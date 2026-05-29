import { useEffect, useRef, useState } from 'react';

/**
 * Generic resize handle for two-pane layouts. Headless: the parent owns the
 * size value and Splitter only emits the new one on drag. Works for both
 * column splits (drag horizontally → resizes the leading pane width) and
 * row splits (drag vertically → resizes the leading pane height).
 *
 * The element is a thin 4-px bar that grows a brand-tinted highlight on
 * hover / while dragging. The cursor flips between `col-resize` and
 * `row-resize` depending on `orientation`. Drag movement is converted to
 * a delta inside the host's bounding box and clamped to `[min, max]`.
 *
 *   <Splitter orientation="vertical" value={px} min={120} max={400}
 *             hostRef={asideRef} onChange={setPx} />
 *
 * `hostRef` points at the element whose **height** (or width) the value
 * describes; the component reads its rect to translate "client coordinate
 * → new size". Optional; if omitted, the splitter falls back to using
 * absolute movement deltas (raw cursor delta added to the previous size).
 */
export function Splitter({
  orientation,
  value,
  onChange,
  min,
  max,
  hostRef,
  leading = 'before',
  ariaLabel,
}: {
  orientation: 'horizontal' | 'vertical';
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  /**
   * Element whose size the value tracks. Used to convert absolute cursor
   * position to a size value. For row-splitters (`orientation='vertical'`)
   * pass the element whose **height** you're controlling.
   */
  hostRef?: React.RefObject<HTMLElement | null>;
  /**
   * Which side of the splitter the value refers to:
   *   - 'before' (default): leading pane (left for horizontal, top for vertical).
   *   - 'after': trailing pane (right / bottom). Use for "footer height", "right sidebar width", etc.
   */
  leading?: 'before' | 'after';
  ariaLabel?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pos: number; value: number; rect: DOMRect | null } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      const start = startRef.current;
      if (!start) return;
      let next: number;
      if (hostRef?.current && start.rect) {
        // Host-relative: size = distance from cursor to the edge of the
        // pane we're tracking. `leading` picks which edge.
        if (orientation === 'horizontal') {
          next = leading === 'before' ? e.clientX - start.rect.left : start.rect.right - e.clientX;
        } else {
          next = leading === 'before' ? e.clientY - start.rect.top : start.rect.bottom - e.clientY;
        }
      } else {
        const axis = orientation === 'horizontal' ? e.clientX : e.clientY;
        const delta = axis - start.pos;
        // For 'after' panes (right/bottom), dragging toward the host shrinks
        // the leading pane → grows ours. Invert sign accordingly.
        const signed = leading === 'before' ? delta : -delta;
        next = start.value + (orientation === 'horizontal' ? signed : signed);
      }
      onChange(Math.max(min, Math.min(max, next)));
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, hostRef, max, min, onChange, orientation]);

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      onMouseDown={(e) => {
        e.preventDefault();
        startRef.current = {
          pos: orientation === 'horizontal' ? e.clientX : e.clientY,
          value,
          rect: hostRef?.current?.getBoundingClientRect() ?? null,
        };
        setDragging(true);
      }}
      className={
        orientation === 'horizontal'
          ? `relative shrink-0 w-1 -mx-px cursor-col-resize z-10 ${dragging ? 'bg-brand/60' : 'bg-transparent hover:bg-brand/40'} transition-colors`
          : `relative shrink-0 h-1 -my-px cursor-row-resize z-10 ${dragging ? 'bg-brand/60' : 'bg-transparent hover:bg-brand/40'} transition-colors`
      }
    />
  );
}
