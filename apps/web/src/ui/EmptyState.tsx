import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-8 py-12">
      <div className="text-3xl mb-2">🪨</div>
      <div className="text-lg font-semibold mb-1 text-ink">{title}</div>
      {description && (
        <div className="text-sm text-ink-muted max-w-md mb-4 leading-relaxed">{description}</div>
      )}
      {children}
    </div>
  );
}
