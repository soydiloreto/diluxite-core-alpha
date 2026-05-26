import { useState, type ReactNode } from 'react';

export function Section({
  title,
  defaultOpen = true,
  children,
  right,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex-1 flex items-center gap-1.5 px-1 py-1 text-xs uppercase tracking-wide text-ink-muted hover:text-ink"
        >
          <span className="inline-block w-3 text-center">{open ? '▾' : '▸'}</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="mt-1 flex flex-col gap-0.5">{children}</div>}
    </div>
  );
}
