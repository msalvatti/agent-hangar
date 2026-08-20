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

import { ConfigError, describeClientFailure } from './errors.ts';

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
    ['a non-string code', Object.assign(new Error('boom'), { code: 28_001 })],
  ])('returns unknown for %s', (_name, value) => {
    expect(describeClientFailure(value)).toBe('unknown');
  });

  /**
   * The guarantee cannot rest on the caller passing a driver-generated value: this is an exported
   * function taking `unknown`. No pattern separates a driver code from a credential — a bare
   * password is as much an identifier as `ECONNREFUSED` — so only a recognised classification is
   * echoed. A connection string, a bare password and an unrecognised code alike report `unknown`.
   */
  it.each([
    ['a connection string', `redis://u:${SECRET}@127.0.0.1:6379`],
    ['a code with punctuation', `ECONNREFUSED: ah:${SECRET}@db`],
    ['a bare password', SECRET],
    ['an over-long code', 'A'.repeat(65)],
    ['an unrecognised code', 'ENOTAREALCODE'],
  ])('refuses %s as a code', (_name, code) => {
    const reported = describeClientFailure(Object.assign(new Error('boom'), { code }));
    expect(reported).toBe('unknown');
    expect(reported).not.toContain(SECRET);
  });

  /**
   * A class name is forgeable — `name` is a configurable property — so the fallback is held to the
   * same list as the code. A nameless class, which an anonymous `class extends Error {}` produces,
   * is refused by it too rather than reaching the message as the empty string it literally is.
   */
  it.each([
    ['a forged class name', SECRET],
    ['an unrecognised class name', 'SomeOtherError'],
    ['no class name at all', ''],
  ])('refuses %s', (_name, className) => {
    class Forged extends Error {}
    Object.defineProperty(Forged, 'name', { value: className });
    const reported = describeClientFailure(new Forged('boom'));
    expect(reported).toBe('unknown');
    expect(reported).not.toContain(SECRET);
  });

  /**
   * The input is `unknown`, so introspecting it is itself an operation that can fail: a throwing
   * `code` getter or a `Proxy` trap would otherwise replace the sanitized error with whatever it
   * threw — which, coming from a driver, is exactly what must not travel.
   */
  it.each([
    [
      'a throwing code getter',
      (): unknown =>
        Object.defineProperty(new Error('boom'), 'code', {
          get: () => {
            throw new Error(`connect ECONNREFUSED redis://u:${SECRET}@h:6379`);
          },
        }),
    ],
    [
      'a proxy whose has trap throws',
      (): unknown =>
        new Proxy(new Error('boom'), {
          has: () => {
            throw new Error(`connect ECONNREFUSED redis://u:${SECRET}@h:6379`);
          },
        }),
    ],
  ])('returns unknown for %s', (_name, build) => {
    expect(describeClientFailure(build())).toBe('unknown');
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
