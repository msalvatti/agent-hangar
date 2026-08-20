/**
 * Unit tests for the transport-failure classification.
 *
 * Layer: unit.
 * Goal: socket errnos are recognised through a wrapper's `cause` chain, everything else is not,
 * and a value that resists introspection answers "no" instead of throwing.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { isTransportError, TRANSPORT_ERROR_CODES } from './errors.js';

describe('isTransportError', () => {
  /**
   * The errnos a local Docker socket produces are what a retry can fix.
   */
  it('recognises a socket errno', () => {
    for (const code of TRANSPORT_ERROR_CODES) {
      expect(isTransportError(Object.assign(new Error('failed'), { code }))).toBe(true);
    }
  });

  /**
   * The Docker runner wraps daemon failures in its own typed error, so the errno is one level
   * down; a classification that only looked at the top would retry nothing.
   */
  it('recognises an errno carried as a cause', () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const wrapper = new Error('could not create the workspace', { cause: socket });

    expect(isTransportError(wrapper)).toBe(true);
  });

  /**
   * A chain that never carries an errno, however deep, is not a transport failure.
   */
  it('rejects a chain with no errno', () => {
    const deep = new Error('c', { cause: new Error('b', { cause: new Error('a') }) });

    expect(isTransportError(deep)).toBe(false);
    expect(isTransportError(new Error('plain'))).toBe(false);
  });

  /**
   * A cyclic chain must terminate rather than hang the worker on classification.
   */
  it('stops walking a cyclic chain', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.defineProperty(first, 'cause', { value: second });

    expect(isTransportError(first)).toBe(false);
  });

  /**
   * Values that are not errors at all reach this function, because it takes `unknown`: a string, a
   * numeric `code`, a missing `code` and a getter that throws must all answer without throwing.
   */
  it('answers for values that are not errors', () => {
    expect(isTransportError('ECONNREFUSED')).toBe(false);
    expect(isTransportError({ code: 42 })).toBe(false);
    expect(isTransportError({})).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
    expect(
      isTransportError({
        get code(): string {
          throw new Error('hostile getter');
        },
      }),
    ).toBe(false);
  });
});
