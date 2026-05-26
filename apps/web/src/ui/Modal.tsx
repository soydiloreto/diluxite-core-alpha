import { useEffect, type ReactNode } from 'react';

type Size = 'md' | 'lg' | 'xl';
const widths: Record<Size, string> = {
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export function Modal({
  open,
  onClose,
  title,
  children,
  size = 'lg',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  size?: Size;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        className={`relative ${widths[size]} w-[92vw] max-h-[88vh] overflow-hidden rounded-xl bg-bg-surface border border-line shadow-2xl flex flex-col`}
      >
        {title && (
          <div className="px-5 py-3 border-b border-line text-base font-semibold flex items-center justify-between">
            <span>{title}</span>
            <button
              onClick={onClose}
              aria-label="cerrar"
              className="text-ink-muted hover:text-ink"
            >
              ✕
            </button>
          </div>
        )}
        <div className="overflow-auto">{children}</div>
      </div>
    </div>
  );
}
