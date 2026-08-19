/**
 * Tests for the infrastructure-failure classifier.
 *
 * Layer: unit (pure).
 * Goal: a driver failure can be reported without repeating anything the client was configured
 * with. Postgres and Redis put the connection string, password included, into the message of a
 * connection error, so neither that message nor the error itself may reach a persisted or logged
 * value.
 * Mocks: none.
 */
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, describeClientFailure } from './errors.js';

/** A password that would be unmistakable if it ever escaped. */
const SECRET = 'SUPERSECRETPW';

/** A connection failure shaped like the ones pg and ioredis actually raise. */
function driverFailure(): Error {
  const url = `postgresql://ah:${SECRET}@127.0.0.1:5432/db`;
  return Object.assign(new Error(`connect ECONNREFUSED for ${url}`), {
    code: 'ECONNREFUSED',
    connectionString: url,
  });
}

describe('describeClientFailure', () => {
  /** The driver's own code is the useful part and cannot carry configuration. */
  it('returns the driver code when there is one', () => {
    expect(describeClientFailure(driverFailure())).toBe('ECONNREFUSED');
  });

  /** Without a code, the class name still says something and still carries nothing. */
  it('falls back to the error class when no code is present', () => {
    class TimeoutError extends Error {}
    expect(describeClientFailure(new TimeoutError('boom'))).toBe('TimeoutError');
  });

  /** A plain Error and a non-error rejection both have to resolve to something printable. */
  it.each([
    ['a plain error', new Error('boom')],
    ['a string rejection', 'boom'],
    ['an empty code', Object.assign(new Error('boom'), { code: '' })],
  ])('returns unknown for %s', (_name, value) => {
    expect(describeClientFailure(value)).toBe('unknown');
  });

  /**
   * The whole point: the reported error must carry the secret nowhere, including through the
   * cause chain that util.inspect, a structured logger and a test reporter all walk.
   */
  it('produces an error whose entire object graph is free of the connection string', () => {
    const reported = new ConfigError(
      `database unreachable (${describeClientFailure(driverFailure())})`,
    );
    expect(reported.message).toBe('database unreachable (ECONNREFUSED)');
    expect(inspect(reported, { depth: null })).not.toContain(SECRET);
    expect(reported.cause).toBeUndefined();
  });
});
