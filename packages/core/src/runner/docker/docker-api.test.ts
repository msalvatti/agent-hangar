/**
 * Unit tests for the Docker error-status predicates.
 *
 * Layer: unit.
 * Goal: the three predicates recognise a daemon rejection by its HTTP status and stay `false` for
 * anything that merely looks like one. They drive the runner's "already gone / already stopped /
 * name taken is fine" decisions, so a false positive would silently swallow a real failure.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { isDockerConflict, isDockerNotFound, isDockerNotModified } from './docker-api.ts';
import { dockerError } from './testing/fake-docker-api.ts';

describe('Docker status predicates', () => {
  /**
   * Each predicate matches exactly its own status and nothing else, so a 409 is never mistaken for
   * a 404 and treated as "the container is gone".
   */
  it('matches only its own status code', () => {
    expect(isDockerNotFound(dockerError(404))).toBe(true);
    expect(isDockerNotFound(dockerError(409))).toBe(false);
    expect(isDockerNotModified(dockerError(304))).toBe(true);
    expect(isDockerNotModified(dockerError(404))).toBe(false);
    expect(isDockerConflict(dockerError(409))).toBe(true);
    expect(isDockerConflict(dockerError(304))).toBe(false);
  });

  /**
   * The value reaching a `catch` is `unknown`: it can be a string thrown by a library, `null`, a
   * plain error without a status, or an object whose `statusCode` is not a number. None of those
   * may be read as a daemon status.
   */
  it.each([
    ['a thrown string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an error without a status', new Error('socket hang up')],
    ['a non-numeric status', Object.assign(new Error('weird'), { statusCode: '404' })],
  ])('returns false for %s', (_case, value) => {
    expect(isDockerNotFound(value)).toBe(false);
    expect(isDockerNotModified(value)).toBe(false);
    expect(isDockerConflict(value)).toBe(false);
  });
});
