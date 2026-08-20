/**
 * Unit tests for the mode reader and the real-stack guard.
 *
 * Layer: unit test.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODE, MODE_ENV, readMode, skipUnlessReal } from './mode';

describe('readMode', () => {
  /** An unset variable must not silently pick the mode that skips the most assertions. */
  it('falls back to the default mode when the variable is unset', () => {
    expect(readMode({})).toBe(DEFAULT_MODE);
  });

  /** A variable set to whitespace is the same as unset, not a typo to reject. */
  it('treats a blank value as unset', () => {
    expect(readMode({ [MODE_ENV]: '   ' })).toBe(DEFAULT_MODE);
  });

  /** Both modes are accepted, and surrounding whitespace is tolerated. */
  it('accepts both modes, trimmed', () => {
    expect(readMode({ [MODE_ENV]: 'mock' })).toBe('mock');
    expect(readMode({ [MODE_ENV]: ' real ' })).toBe('real');
  });

  /** A typo must fail the run rather than quietly select a mode nobody asked for. */
  it('rejects anything else', () => {
    expect(() => readMode({ [MODE_ENV]: 'moc' })).toThrow(/must be one of mock, real/);
  });
});

describe('skipUnlessReal', () => {
  /** In mock mode the guard skips, and the reason names what the stack is missing. */
  it('skips in mock mode with the reason spelled out', () => {
    const test = { skip: vi.fn() };
    skipUnlessReal(test, 'mock', 'the worker');
    expect(test.skip).toHaveBeenCalledWith(true, 'needs real stack: the worker');
  });

  /** In real mode the guard is a no-op condition, so the test carries on. */
  it('does not skip in real mode', () => {
    const test = { skip: vi.fn() };
    skipUnlessReal(test, 'real', 'the worker');
    expect(test.skip).toHaveBeenCalledWith(false, 'needs real stack: the worker');
  });
});
