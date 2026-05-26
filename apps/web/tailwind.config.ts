import type { Config } from 'tailwindcss';

// Diluxite v2 design tokens. Preflight desactivado para coexistir con CSS heredado
// y dar control fino sobre la estética (mismo enfoque que dilux-claw).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="oscuro"]'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#008671', hover: '#00a085', soft: '#202b29' },
        ink: { DEFAULT: '#ddd', muted: '#888' },
        bg: { DEFAULT: '#1a1a1a', surface: '#141414' },
        line: '#2a2a2a',
        danger: { DEFAULT: '#5a1f1f', soft: '#7a2727', ink: '#ffb4b4' },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { md: '6px', lg: '8px', xl: '10px' },
    },
  },
} satisfies Config;
