import type { ReactNode } from 'react';

export function StatusBar({ children }: { children: ReactNode }) {
  return (
    <div className="h-9 px-3 flex items-center gap-3 border-t border-line bg-bg-surface text-xs text-ink-muted shrink-0">
      {children}
    </div>
  );
}

export function StatusItem({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const cls = 'inline-flex items-center gap-1 px-2 py-1 rounded';
  return onClick ? (
    <button type="button" onClick={onClick} title={title} className={`${cls} hover:bg-bg text-ink`}>
      {children}
    </button>
  ) : (
    <span title={title} className={cls}>
      {children}
    </span>
  );
}
