import type { SelectHTMLAttributes } from 'react';

export function Select({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`px-2 py-1.5 text-sm rounded-md border border-line bg-bg text-ink outline-none focus:border-brand ${className}`}
    />
  );
}
