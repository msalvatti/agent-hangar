/**
 * Unit tests for the secret-specific error class.
 *
 * Layer: unit.
 * Goal: the refusal a caller is handed for an unusable secret value carries both the sentence the
 * settings form shows and the code the route branches on.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { InvalidSecretError } from './errors.ts';

describe('InvalidSecretError', () => {
  /**
   * The message is what somebody submitting an empty field reads, and the code is what the route
   * maps to a 400 rather than a 500; nothing else in this package reads either back.
   */
  it('names the rule it applied and carries its code', () => {
    const error = new InvalidSecretError();

    expect(error.message).toBe('Secret value must be a non-empty string.');
    expect(error.code).toBe('SECRET_INVALID');
  });
});
