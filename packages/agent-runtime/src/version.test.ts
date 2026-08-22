/**
 * Unit tests for the runtime version constant.
 *
 * Layer: unit.
 * Goal: both branches of the bundle-time `define` are exercised — the dev fallback when the
 * global is absent, and the injected literal when esbuild has replaced it.
 * Mocks: `vi.stubGlobal` stands in for esbuild's `define`.
 *
 * The module is reached through `await import()` in every test rather than through a static import
 * at the top of the file. Outside the bundle `__AGENT_RUNTIME_VERSION__` is not merely undefined,
 * it is undeclared, so any code that drops the `typeof` guard throws a `ReferenceError` while the
 * module is being evaluated. Under a static import that error lands during collection, the file
 * reports no tests at all, and a run that produces no failing test reads as a passing one to
 * anything judging by test results. Imported inside the test, the same error is that test failing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('RUNTIME_VERSION', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Outside the esbuild bundle nothing defines `__AGENT_RUNTIME_VERSION__`. */
  it('falls back to the dev marker when the bundle-time global is absent', async () => {
    vi.resetModules();
    const { RUNTIME_VERSION } = await import('./version.js');
    expect(RUNTIME_VERSION).toBe('0.0.0-dev');
  });

  /** `define` replaces the identifier with a string literal; a stubbed global reproduces that. */
  it('reports the value injected at bundle time when the global is a string', async () => {
    vi.stubGlobal('__AGENT_RUNTIME_VERSION__', '1.2.3');
    vi.resetModules();
    const { RUNTIME_VERSION } = await import('./version.js');
    expect(RUNTIME_VERSION).toBe('1.2.3');
  });

  /**
   * A global of the wrong type is what a broken `define` produces, and the guard is a `typeof`
   * check rather than a truthiness test precisely so that case falls back instead of reporting a
   * number as the version.
   */
  it('falls back to the dev marker when the bundle-time global is not a string', async () => {
    vi.stubGlobal('__AGENT_RUNTIME_VERSION__', 123);
    vi.resetModules();
    const { RUNTIME_VERSION } = await import('./version.js');
    expect(RUNTIME_VERSION).toBe('0.0.0-dev');
  });
});
