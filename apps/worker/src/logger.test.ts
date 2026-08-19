/**
 * Unit tests for the worker logger factory.
 *
 * Layer: unit.
 * Goal: pretty transport only in interactive development; plain JSON otherwise; `createLogger`
 * returns a working pino instance at the requested level.
 * Mocks: none (environment hints are passed explicitly).
 */
import { describe, expect, it } from 'vitest';

import { buildLoggerOptions, createLogger } from './logger.js';

describe('buildLoggerOptions', () => {
  /**
   * Development on a TTY: human-readable output via pino-pretty.
   */
  it('uses the pretty transport in development on a TTY', () => {
    const options = buildLoggerOptions({ level: 'debug', nodeEnv: 'development', isTty: true });
    expect(options.level).toBe('debug');
    expect(options.transport).toEqual({ target: 'pino-pretty', options: { colorize: true } });
  });

  /**
   * Production, or a non-TTY stdout (logs piped to a file/collector), stays JSON — no transport.
   */
  it('stays JSON in production or when stdout is not a TTY', () => {
    expect(
      buildLoggerOptions({ level: 'info', nodeEnv: 'production', isTty: true }).transport,
    ).toBeUndefined();
    expect(
      buildLoggerOptions({ level: 'info', nodeEnv: 'development', isTty: false }).transport,
    ).toBeUndefined();
  });

  /**
   * Defaults read `NODE_ENV` and `process.stdout.isTTY`; under the test runner stdout is not a
   * TTY, so the default is the JSON configuration.
   */
  it('reads the environment by default', () => {
    const options = buildLoggerOptions({ level: 'warn' });
    expect(options.name).toBe('worker');
    expect(options.transport).toBeUndefined();
  });
});

describe('createLogger', () => {
  /**
   * Returns a pino logger at the requested level.
   */
  it('creates a pino logger at the requested level', () => {
    const logger = createLogger('silent');
    expect(logger.level).toBe('silent');
    expect(typeof logger.info).toBe('function');
  });
});
