import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// localStorage / sessionStorage — Node 22+ ships a native *experimental*
// localStorage that throws unless started with `--localstorage-file`, and it
// shadows jsdom's. So tests that touch storage pass on the pinned Node (24) but
// blow up on a newer local Node (e.g. 26). Install a deterministic in-memory
// Storage so behaviour is identical across Node versions and in CI.
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const value = new MemoryStorage() as unknown as Storage;
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { configurable: true, writable: true, value });
  }
}

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
