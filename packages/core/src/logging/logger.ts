/**
 * The pino logger factory every process uses.
 *
 * Layer: utility.
 *
 * Redaction is structural here, never something a call site has to remember. Five independent
 * layers run on every record:
 *
 * 1. `redact` paths blank the fields that are sensitive by name, whatever their value looks like.
 * 2. `hooks.logMethod` scrubs the message, the interpolation arguments and the merge object
 *    before pino formats them, so a credential cannot reach `msg` through `%s` or `%o`.
 * 3. `formatters.log` and `formatters.bindings` scrub the merged record and every child binding.
 * 4. `serializers.err` scrubs the message and stack of a logged error, which routinely quote the
 *    input that caused them.
 * 5. `hooks.streamWrite` scrubs the finished line as a last resort, covering anything the earlier
 *    layers could not walk. A line that redaction would leave as invalid JSON is dropped rather
 *    than written, because a malformed line is recoverable and a leaked credential is not.
 *
 * No transport is configured: pretty printing is the application's decision, and a transport
 * would move serialisation into a worker thread where these hooks do not run.
 *
 * The default `base` is empty, so no hostname or process id is attached unless a caller asks for
 * it.
 */
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import { REDACTED_TOKEN } from '../secrets/types.js';
import type { Redactor } from '../secrets/types.js';

/**
 * Fields blanked by name, regardless of their content.
 *
 * The single `*` wildcard matches one level, so each path is listed both at the root and one level
 * down, which is where merge objects put them.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'env.GITHUB_TOKEN',
  'env.OPENAI_API_KEY',
  '*.env.GITHUB_TOKEN',
  '*.env.OPENAI_API_KEY',
  'headers.authorization',
  '*.headers.authorization',
  'secret',
  '*.secret',
  'plaintext',
  '*.plaintext',
  'apiKey',
  '*.apiKey',
  'token',
  '*.token',
];

/** Line written when redaction would have produced invalid JSON. */
const SUPPRESSED_LINE = `${JSON.stringify({
  msg: 'A log line was dropped: redaction left it as invalid JSON.',
})}\n`;

/** The redactor surface the logger needs. */
export type LoggerRedactor = Pick<Redactor, 'redact' | 'redactJson'>;

/** Options of {@link createLogger}. */
export interface CreateLoggerOptions {
  /** pino level name; `silent` disables output entirely. */
  level: string;
  /** Redactor applied to messages, records, bindings, errors and finished lines. */
  redactor: LoggerRedactor;
  /** Logger name attached to every record. */
  name?: string;
  /** Fields attached to every record; defaults to none, so no hostname or process id is logged. */
  base?: Record<string, unknown>;
  /** Where records are written; defaults to pino's standard output stream. */
  destination?: DestinationStream;
}

/**
 * Scrubs a serialised error, whose message and stack routinely quote the input that failed.
 *
 * @param serialized - Output of pino's standard error serializer.
 * @param redact - String redaction function.
 * @returns A new record with every string property scrubbed.
 */
function redactSerializedError(
  serialized: Record<string, unknown>,
  redact: (value: string) => string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(serialized)) {
    result[redact(key)] = typeof value === 'string' ? redact(value) : value;
  }
  return result;
}

/**
 * Applies the last-resort scrub to a finished line, keeping the output parseable.
 *
 * @param line - Serialised record, newline terminated.
 * @param redact - String redaction function.
 * @returns The scrubbed line, or a fixed notice when scrubbing broke the JSON.
 */
function redactLine(line: string, redact: (value: string) => string): string {
  const scrubbed = redact(line);
  if (scrubbed === line) {
    return line;
  }
  try {
    JSON.parse(scrubbed);
    return scrubbed;
  } catch {
    return SUPPRESSED_LINE;
  }
}

/**
 * Builds the pino options a redacting logger is created from.
 *
 * @param options - Level, redactor and optional name, base and destination.
 * @returns Options ready to hand to pino.
 */
function buildLoggerOptions(options: CreateLoggerOptions): LoggerOptions {
  const { redactor } = options;
  const redact = (value: string): string => redactor.redact(value);
  return {
    level: options.level,
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED_TOKEN },
    formatters: {
      // `redactJson` rebuilds plain objects as plain objects, so the record keeps its shape.
      log: (record) => redactor.redactJson(record) as Record<string, unknown>,
      bindings: (bindings) => redactor.redactJson(bindings) as Record<string, unknown>,
    },
    serializers: {
      err: (error: Error) => redactSerializedError(pino.stdSerializers.err(error), redact),
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((argument: unknown) => redactor.redactJson(argument));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
      streamWrite: (line) => redactLine(line, redact),
    },
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

/**
 * Creates a logger that cannot print a credential.
 *
 * @param options - Level, redactor and optional name, base and destination.
 * @returns A pino logger writing to the given destination, or to standard output.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions = buildLoggerOptions(options);
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}
