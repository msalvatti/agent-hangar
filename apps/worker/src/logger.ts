/**
 * pino logger factory for the worker.
 *
 * Layer: utility.
 *
 * Pretty output only in development on a TTY; JSON otherwise. The redaction serializer from the
 * core logging module is wired in by the secrets lane; until then the logger never receives
 * secret material because nothing in the boot path handles any.
 */
import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

/** Options of {@link createLogger}. */
export interface CreateLoggerOptions {
  /** pino level name. */
  level: string;
  /** `NODE_ENV` (defaults to `process.env.NODE_ENV`). */
  nodeEnv?: string | undefined;
  /** Whether stdout is a TTY (defaults to `process.stdout.isTTY`). */
  isTty?: boolean | undefined;
}

/**
 * Builds the pino options for the given environment.
 *
 * @param options - Level and environment hints.
 * @returns pino options (with the pretty transport in interactive development).
 */
export function buildLoggerOptions(options: CreateLoggerOptions): LoggerOptions {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const isTty = options.isTty ?? process.stdout.isTTY;
  const base: LoggerOptions = { level: options.level, name: 'worker' };
  if (nodeEnv !== 'production' && isTty) {
    return { ...base, transport: { target: 'pino-pretty', options: { colorize: true } } };
  }
  return base;
}

/**
 * Creates the worker logger.
 *
 * @param level - pino level name.
 * @returns A pino logger.
 */
export function createLogger(level: string): Logger {
  return pino(buildLoggerOptions({ level }));
}
