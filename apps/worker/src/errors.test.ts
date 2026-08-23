/**
 * Unit tests for the transport-failure classification.
 *
 * Layer: unit.
 * Goal: socket errnos are recognised through a wrapper's `cause` chain, everything else is not,
 * and a value that is not an error at all answers "no" instead of throwing.
 * Mocks: none.
 */
import { NotFoundError } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { isMissingRow, isTransportError, TRANSPORT_ERROR_CODES } from './errors.js';

/**
 * The nine errnos, written out here rather than read from the module under test.
 *
 * Reading the list from the export and asserting over it proves nothing: emptying one of the
 * source literals empties the case derived from it too, so the loop still passes with a set the
 * daemon's real errno is no longer in.
 */
const SOCKET_ERRNOS = [
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
] as const;

describe('isTransportError', () => {
  /**
   * The errnos a local Docker socket produces are what a retry can fix.
   */
  it.each(SOCKET_ERRNOS)('recognises the socket errno %s', (code) => {
    expect(isTransportError(Object.assign(new Error('failed'), { code }))).toBe(true);
  });

  /**
   * And nothing beyond those nine. The set is what the classification is, so a code silently added
   * to it — or one of these silently emptied — changes which failures are reported as the operator's
   * infrastructure rather than as the user's work.
   */
  it('recognises exactly those nine and no others', () => {
    expect(TRANSPORT_ERROR_CODES).toStrictEqual(new Set(SOCKET_ERRNOS));
    expect(isTransportError(Object.assign(new Error('failed'), { code: 'EAGAIN' }))).toBe(false);
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
   * The walk is bounded by depth alone, and the bound is five links: a wrapper around a wrapper is
   * ordinary, an unbounded walk is what a cyclic chain turns into a hang, and a bound that counts
   * one link too many or too few decides differently about a real chain.
   */
  it('walks exactly five links of the chain', () => {
    const chain = (length: number): Error => {
      let error = Object.assign(new Error('socket'), { code: 'ECONNREFUSED' });
      for (let link = 1; link < length; link += 1) {
        error = new Error(`wrapper ${String(link)}`, { cause: error }) as typeof error;
      }
      return error;
    };

    expect(isTransportError(chain(5))).toBe(true);
    expect(isTransportError(chain(6))).toBe(false);
  });

  /**
   * Only an `Error` has its `cause` followed. A plain object that happens to carry the word is not
   * a chain — following it would let any payload with a `cause` field steer the classification of
   * a failure that is not one.
   */
  it('does not follow the cause of something that is not an Error', () => {
    const shaped = { cause: Object.assign(new Error('socket'), { code: 'ECONNREFUSED' }) };

    expect(isTransportError(shaped)).toBe(false);
  });

  /**
   * A `code` defined as a getter is not read at all: the descriptor carries no value, and the
   * getter — which could throw the driver error and its connection string — is never invoked.
   */
  it('does not invoke a code defined as a getter', () => {
    let invoked = 0;
    const hostile = {
      get code(): string {
        invoked += 1;
        return 'ECONNREFUSED';
      },
    };

    expect(isTransportError(hostile)).toBe(false);
    expect(invoked).toBe(0);
  });

  /**
   * Values that are not errors at all reach this function, because it takes `unknown`: a string, a
   * numeric `code`, a missing `code`, the two values that have no properties at all and a symbol
   * must every one of them answer without throwing.
   */
  it('answers for values that are not errors', () => {
    expect(isTransportError('ECONNREFUSED')).toBe(false);
    expect(isTransportError({ code: 42 })).toBe(false);
    expect(isTransportError({})).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(Symbol('code'))).toBe(false);
  });
});

describe('isMissingRow', () => {
  /**
   * The expected case: the repository reported the very row this write named as gone, which is how
   * a processor learns a concurrent delete beat it rather than that the write went wrong.
   */
  it('recognises the row the caller named', () => {
    expect(isMissingRow(new NotFoundError('ScheduledJob', 'job-1'), 'ScheduledJob', 'job-1')).toBe(
      true,
    );
  });

  /**
   * A not-found about some other row is a failure like any other. Comparing only the error type
   * would swallow a write that went to the wrong place — the entity and the identifier are both
   * part of the question.
   */
  it.each([
    ['another entity', 'Chat', 'job-1'],
    ['another identifier', 'ScheduledJob', 'job-2'],
    ['both', 'Chat', 'job-2'],
  ])('refuses a not-found about %s', (_case, entity, id) => {
    expect(isMissingRow(new NotFoundError(entity, id), 'ScheduledJob', 'job-1')).toBe(false);
  });

  /**
   * And a failure that is not a not-found at all is never the expected one, however it is worded.
   */
  it('refuses an error of another kind', () => {
    expect(
      isMissingRow(new Error('ScheduledJob job-1 was not found.'), 'ScheduledJob', 'job-1'),
    ).toBe(false);
    expect(isMissingRow(undefined, 'ScheduledJob', 'job-1')).toBe(false);
  });
});
