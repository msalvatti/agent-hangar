/**
 * Unit tests for the worker logger factory.
 *
 * Layer: unit.
 * Goal: the factory returns a pino logger at the requested level, names it `worker`, writes to an
 * injected destination, and routes everything it writes through the redactor it was given.
 * Mocks: an in-memory destination stream and a redactor that replaces a canary.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { createLogger, WORKER_LOGGER_NAME } from './logger.js';

/** Collects the finished lines pino writes, so a test can assert on the serialised record. */
function collectingDestination(): { lines: string[]; stream: DestinationStream } {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(line: string): void {
        lines.push(line);
      },
    },
  };
}

/** A redactor that only knows the GitHub canary, which is enough to prove it is consulted. */
const redactor = {
  redact: (input: string): string => input.replaceAll(GITHUB_CANARY, '[REDACTED]'),
  redactJson: (input: unknown): unknown =>
    typeof input === 'string' ? input.replaceAll(GITHUB_CANARY, '[REDACTED]') : input,
};

describe('createLogger', () => {
  /**
   * The level is forwarded to pino and the process name is attached to every record.
   */
  it('creates a pino logger at the requested level, named for the worker', () => {
    const logger = createLogger({ level: 'silent', redactor });
    expect(logger.level).toBe('silent');
    expect(typeof logger.info).toBe('function');
  });

  /**
   * With a destination the records land there, carrying the worker name, which is what makes the
   * logger assertable in the tests of every other module.
   */
  it('writes named records to an injected destination', () => {
    const { lines, stream } = collectingDestination();
    createLogger({ level: 'info', redactor, destination: stream }).info('ready');
    expect(lines).toHaveLength(1);
    const record: unknown = JSON.parse(lines[0]!);
    // The name is written out rather than compared against the export it came from: every other
    // module's tests find the worker's records by this word, so a comparison of the constant with
    // itself would let it change to anything and still pass.
    expect(record).toMatchObject({ name: 'worker', msg: 'ready' });
    expect(WORKER_LOGGER_NAME).toBe('worker');
  });

  /**
   * The redactor is wired into the factory rather than left to call sites: a credential logged by
   * accident must never reach the destination.
   */
  it('scrubs a credential out of everything it writes', () => {
    const { lines, stream } = collectingDestination();
    createLogger({ level: 'info', redactor, destination: stream }).info(
      { clone: `https://${GITHUB_CANARY}@github.com/o/r.git` },
      `cloning with ${GITHUB_CANARY}`,
    );
    expect(lines[0]).not.toContain(GITHUB_CANARY);
    expect(lines[0]).toContain('[REDACTED]');
  });
});
