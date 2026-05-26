import { forwardRef, type InputHTMLAttributes } from 'react';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        {...rest}
        className={`px-2.5 py-1.5 text-sm rounded-md border border-line bg-bg text-ink outline-none focus:border-brand placeholder:text-ink-muted ${className}`}
      />
    );
  },
);
