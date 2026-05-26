import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-ink hover:bg-bg-surface transition-colors ${className}`}
    >
      {children}
    </button>
  );
}
