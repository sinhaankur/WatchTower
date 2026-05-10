// Vitest setup. Runs once before any test file.
//
// 1. RTL's matchers (`toBeInTheDocument`, etc.).
// 2. A jsdom-friendly stub for window.matchMedia (Tailwind / various
//    Radix primitives call it during render and jsdom doesn't provide it).
// 3. Polyfill localStorage if missing.
// 4. ResizeObserver / IntersectionObserver — Radix and other libs call
//    these on mount and crash tests if absent.
import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  if (!window.ResizeObserver) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!window.IntersectionObserver) {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = '';
      thresholds = [];
    };
  }
  if (!window.scrollTo) {
    (window as unknown as { scrollTo: unknown }).scrollTo = () => {};
  }

  // Some Node + Vitest combinations leave `window.localStorage` as a
  // bare object without the Storage methods. Replace with a minimal
  // in-memory shim.
  const ls = window.localStorage;
  if (!ls || typeof ls.setItem !== 'function') {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
      },
    });
  }
}
