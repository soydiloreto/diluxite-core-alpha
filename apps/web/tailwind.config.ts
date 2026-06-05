import type { Config } from 'tailwindcss';

// Diluxite v2 design tokens — todo via CSS variables para alternar tema claro/oscuro
// sin tocar componentes. Preflight ON: reset estándar (fondos transparentes en botones, etc.).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'var(--c-brand)',
          hover: 'var(--c-brand-hover)',
          soft: 'var(--c-brand-soft)',
        },
        ink: { DEFAULT: 'var(--c-ink)', muted: 'var(--c-ink-muted)' },
        bg: { DEFAULT: 'var(--c-bg)', surface: 'var(--c-bg-surface)' },
        line: 'var(--c-line)',
        danger: {
          DEFAULT: 'var(--c-danger)',
          soft: 'var(--c-danger-soft)',
          ink: 'var(--c-danger-ink)',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { md: '6px', lg: '8px', xl: '10px' },
    },
  },
} satisfies Config;
