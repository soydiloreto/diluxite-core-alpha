import type { ReactNode } from 'react';

export function ListItem({
  active,
  onClick,
  children,
  right,
  className = '',
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-md text-sm ${
        active ? 'bg-brand text-white' : 'hover:bg-bg-surface'
      } ${className}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 min-w-0 text-left px-2 py-1.5 truncate"
      >
        {children}
      </button>
      {right && <div className="pr-1">{right}</div>}
    </div>
  );
}
