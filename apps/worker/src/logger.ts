/**
 * pino logger factory for the worker.
 *
 * Layer: utility.
 *
 * Delegates to the redacting factory in the core logging module, which scrubs the message, the
 * merge object, every child binding, serialised errors and the finished line. The worker is the
 * one process that holds credentials in memory, so it is the one that must not be able to print
 * them.
 *
 * That rules out pretty printing: a pino transport serialises records in a worker thread where
 * none of those hooks run, so a pretty logger would bypass the whole defence for the sake of
 * colour. Development output is therefore JSON, like production.
 */
import { createLogger as createRedactingLogger } from '@agent-hangar/core';
import type { LoggerRedactor } from '@agent-hangar/core';
import type { DestinationStream, Logger } from 'pino';

/** Name attached to every record this process writes. */
export const WORKER_LOGGER_NAME = 'worker';

/** Options of {@link createLogger}. */
export interface CreateWorkerLoggerOptions {
  /** pino level name; `silent` disables output entirely. */
  level: string;
  /** Redactor applied to everything that is logged. */
  redactor: LoggerRedactor;
  /** Where records are written; defaults to pino's standard output stream. */
  destination?: DestinationStream | undefined;
}

/**
 * Creates the worker logger.
 *
 * @param options - Level, redactor and optional destination.
 * @returns A pino logger that cannot print a registered credential or a credential-shaped value.
 */
export function createLogger(options: CreateWorkerLoggerOptions): Logger {
  return createRedactingLogger({
    level: options.level,
    redactor: options.redactor,
    name: WORKER_LOGGER_NAME,
    ...(options.destination === undefined ? {} : { destination: options.destination }),
  });
}
