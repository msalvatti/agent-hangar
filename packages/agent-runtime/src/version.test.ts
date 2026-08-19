/**
 * Unit tests for the runtime version constant.
 *
 * Layer: unit.
 * Goal: both branches of the bundle-time `define` are exercised — the dev fallback when the
 * global is absent, and the injected literal when esbuild has replaced it.
 * Mocks: `vi.stubGlobal` stands in for esbuild's `define`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_VERSION } from './version.js';

describe('RUNTIME_VERSION', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('falls back to the dev marker when the bundle-time global is absent', () => {
    // Outside the esbuild bundle nothing defines `__AGENT_RUNTIME_VERSION__`.
    expect(RUNTIME_VERSION).toBe('0.0.0-dev');
  });

  it('reports the value injected at bundle time when the global is a string', async () => {
    // `define` replaces the identifier with a string literal; a stubbed global reproduces that.
    vi.stubGlobal('__AGENT_RUNTIME_VERSION__', '1.2.3');
    vi.resetModules();
    const reloaded = await import('./version.js');
    expect(reloaded.RUNTIME_VERSION).toBe('1.2.3');
  });
});
