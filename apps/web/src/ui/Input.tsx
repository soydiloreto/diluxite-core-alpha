import type { InputHTMLAttributes } from 'react';

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`px-2.5 py-1.5 text-sm rounded-md border border-line bg-bg text-ink outline-none focus:border-brand placeholder:text-ink-muted ${className}`}
    />
  );
}
