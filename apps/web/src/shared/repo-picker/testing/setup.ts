/**
 * Vitest setup: polyfills two DOM APIs jsdom does not implement but `cmdk` (used by
 * `RepoPicker`/`BranchPicker`) calls unconditionally — `ResizeObserver` on mount, and
 * `Element.prototype.scrollIntoView` whenever the highlighted item changes.
 *
 * Layer: shared (test setup). Excluded from coverage: pure environment wiring.
 *
 * Every polyfill is guarded on the global it patches, because this file runs for the whole unit
 * project and a suite that declares `@vitest-environment node` has no DOM to patch.
 */

class ResizeObserverPolyfill {
  observe(): void {
    // No-op: nothing here reads reported sizes: cmdk only needs the constructor to exist.
  }

  unobserve(): void {
    // No-op, see observe().
  }

  disconnect(): void {
    // No-op, see observe().
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // No-op: nothing here asserts on scroll position; cmdk only needs the method to exist.
  };
}
