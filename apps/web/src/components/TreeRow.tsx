import { forwardRef, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from '../icons';

/**
 * One row of a generic tree (folder, note, anything). VS Code-style:
 *
 *   [indent  ··  chevron│spacer  ·  icon  ·  label  ····  actions]
 *
 * The chevron is always present so items at the same depth line up
 * regardless of whether they expand. Folders pass `expandable` to
 * activate it; leaves leave it as a 14-px spacer.
 *
 * Width of one indent step is 12 px — matches VS Code's tree exactly.
 * The chevron/spacer is always 14 px and the icon is 14 px, so a
 * folder and a leaf at the same depth share the same icon column.
 */
export interface TreeRowProps {
  depth: number;
  /** Show the chevron (and react to clicks on the row's left edge). */
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;

  /** Leading icon (after the chevron / spacer). */
  icon?: ReactNode;
  label: string;
  /** Tooltip text — defaults to `label`. */
  title?: string;

  active?: boolean;
  /** Brand ring to show a drop target while dragging over. */
  highlighted?: boolean;

  /** Right-aligned hover-revealed actions (icon buttons). */
  actions?: ReactNode;

  onClick?: () => void;
  onContextMenu?: (e: MouseEvent) => void;

  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: (e: DragEvent) => void;
  onDrop?: (e: DragEvent) => void;
}

const INDENT_PX = 12;

export const TreeRow = forwardRef<HTMLDivElement, TreeRowProps>(function TreeRow(
  {
    depth,
    expandable,
    expanded,
    onToggle,
    icon,
    label,
    title,
    active,
    highlighted,
    actions,
    onClick,
    onContextMenu,
    draggable,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
  },
  ref,
) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div
      ref={ref}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={onContextMenu}
      className={`group flex items-center rounded text-sm min-w-0 ${
        active ? 'bg-brand text-white' : 'hover:bg-bg-surface text-ink'
      } ${highlighted ? 'ring-1 ring-brand bg-brand-soft/40' : ''}`}
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          aria-label={expanded ? 'collapse' : 'expand'}
          className="shrink-0 w-[14px] h-6 inline-flex items-center justify-center text-ink-muted hover:text-ink"
        >
          <Chevron size={14} />
        </button>
      ) : (
        <span aria-hidden className="shrink-0 inline-block w-[14px]" />
      )}

      {icon && (
        <span
          className={`shrink-0 inline-flex items-center justify-center w-[18px] ${
            active ? 'text-white/80' : 'text-ink-muted'
          }`}
        >
          {icon}
        </span>
      )}

      <button
        type="button"
        onClick={onClick}
        title={title ?? label}
        className="flex-1 min-w-0 text-left py-1 px-1 truncate"
      >
        {label}
      </button>

      {actions && (
        <div className="flex shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
});
