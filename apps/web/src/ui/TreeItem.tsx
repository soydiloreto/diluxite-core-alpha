import type { ReactNode } from 'react';

export function TreeItem({
  depth = 0,
  expandable = false,
  expanded = false,
  onToggle,
  active,
  onClick,
  children,
  right,
  icon,
}: {
  depth?: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  right?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-md text-sm ${
        active ? 'bg-brand text-white' : 'hover:bg-bg-surface'
      }`}
      style={{ paddingLeft: depth * 12 }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-4 text-center text-ink-muted hover:text-ink"
        aria-label={expandable ? (expanded ? 'colapsar' : 'expandir') : undefined}
      >
        {expandable ? (expanded ? '▾' : '▸') : ''}
      </button>
      {icon && <span className="text-xs">{icon}</span>}
      <button
        type="button"
        onClick={onClick}
        className="flex-1 min-w-0 text-left py-1 px-1 truncate"
      >
        {children}
      </button>
      {right && <div className="pr-1 opacity-0 group-hover:opacity-100 transition-opacity">{right}</div>}
    </div>
  );
}
