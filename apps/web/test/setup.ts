import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// ───── jsdom polyfills used across tests ─────────────────────────────────
// canvas — GraphView short-circuits when getContext returns null, so we hand
// it null to keep tests quiet.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext;

// ResizeObserver — cmdk (TopBar + CommandPalette) registers one per Command.List.
if (!('ResizeObserver' in globalThis)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// scrollIntoView — cmdk Item focuses + scrolls itself into view on highlight.
if (!Element.prototype.scrollIntoView) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).scrollIntoView = vi.fn();
}

// matchMedia — some libraries (incl. Dockview, theme detection) read it.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
