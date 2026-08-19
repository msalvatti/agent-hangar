/**
 * Unit tests for `cn`.
 *
 * Layer: unit.
 * Goal: conditional classes are joined and Tailwind conflicts resolve to the last value.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  /**
   * Falsy values are dropped, arrays/objects are flattened, and a later Tailwind utility of the
   * same group (`p-4` after `p-2`) wins instead of both being emitted.
   */
  it('joins conditional classes and resolves Tailwind conflicts', () => {
    const hidden = false as boolean;
    expect(
      cn('p-2', hidden && 'hidden', ['text-sm', { 'font-bold': true, italic: false }], 'p-4'),
    ).toBe('text-sm font-bold p-4');
    expect(cn()).toBe('');
  });
});
