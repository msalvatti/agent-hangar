/**
 * Tests for the small "present" assertion.
 */
import { describe, expect, it } from 'vitest';

import { assertPresent } from './assert';

describe('assertPresent', () => {
  // A non-null, non-undefined value is returned unchanged.
  it('returns the value when present', () => {
    expect(assertPresent(42, 'missing')).toBe(42);
  });

  // null throws with the given message.
  it('throws for null', () => {
    expect(() => assertPresent(null, 'missing value')).toThrow('missing value');
  });

  // undefined throws with the given message.
  it('throws for undefined', () => {
    expect(() => {
      assertPresent(undefined, 'missing value');
    }).toThrow('missing value');
  });
});
