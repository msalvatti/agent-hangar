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
 * 3. `formatters.log` and `formatters.bindings` scrub the merged record and every child binding,
 *    and blank the value of every sensitive field name found anywhere inside them.
 * 4. `serializers.err` scrubs the message and stack of a logged error, which routinely quote the
 *    input that caused them, and scrubs a non-`Error` `err` value without mangling it. pino runs
 *    serializers after `formatters.log`, so this is the only structural pass over an error.
 * 5. `hooks.streamWrite` scrubs the finished line as a last resort, covering anything the earlier
 *    layers could not walk, and blanks the value of every sensitive field name wherever it appears
 *    in the serialised record. A line that redaction would leave as invalid JSON is dropped rather
 *    than written, because a malformed line is recoverable and a leaked credential is not.
 *
 * Three layers work by field name, and all three are needed. pino's `redact` paths (layer 1) are
 * matched case-sensitively and reach one level below the root, so `{ headers: { Authorization } }`,
 * `{ cfg: { ApiKey } }` and an `authorization` three levels down all slip past them. Layer 3 blanks
 * a sensitive field structurally, at any depth and in any spelling, and replaces the **whole**
 * value — a credential does not stop being one because it was wrapped in an object or an array.
 * Layer 5 runs over the finished JSON text, which costs nothing and catches whatever the walk could
 * not rebuild, such as a class instance pino serialises itself; it replaces only the interior of a
 * string value, so the line stays parseable.
 *
 * No transport is configured: pretty printing is the application's decision, and a transport
 * would move serialisation into a worker thread where these hooks do not run.
 *
 * The default `base` is empty, so no hostname or process id is attached unless a caller asks for
 * it.
 */
import pino from 'pino';
import type { Bindings, ChildLoggerOptions, DestinationStream, Logger, LoggerOptions } from 'pino';

import { CIRCULAR_TOKEN } from '../redaction/redactor.ts';
import { REDACTED_TOKEN } from '../secrets/types.ts';
import type { Redactor } from '../secrets/types.ts';

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

/**
 * Field names whose value is blanked wherever it appears in a record, at any depth and in any
 * spelling. Kept in step with {@link LOG_REDACT_PATHS}; a test asserts every name here is actually
 * blanked, so a name added to one list without the other fails the build.
 */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'GITHUB_TOKEN',
  'OPENAI_API_KEY',
  'authorization',
  'secret',
  'plaintext',
  'apiKey',
  'token',
];

/**
 * One pattern per {@link SENSITIVE_FIELD_NAMES} entry, matching the interior of that field's string
 * value in a serialised record.
 *
 * The key is matched in a lookbehind so only the value is replaced and the surrounding JSON
 * survives, `i` makes the field name case-insensitive, and `(?:[^"\\]|\\.)*` walks the string
 * body without stopping at an escaped quote. They are written out as literals rather than built
 * from the names above because `security/detect-non-literal-regexp` rejects compiling a pattern
 * from a non-literal source and this project allows no suppressions.
 *
 * No whitespace is allowed around the colon, because none can be there: the only text these ever
 * read is a line this logger has just written, and that is pino's own JSON with nothing between a
 * key and its value. A document quoted inside a message is not reachable either way — its quotes
 * arrive escaped, so the key never appears as the lookbehind spells it.
 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /(?<="GITHUB_TOKEN":")(?:[^"\\]|\\.)*/gi,
  /(?<="OPENAI_API_KEY":")(?:[^"\\]|\\.)*/gi,
  /(?<="authorization":")(?:[^"\\]|\\.)*/gi,
  /(?<="secret":")(?:[^"\\]|\\.)*/gi,
  /(?<="plaintext":")(?:[^"\\]|\\.)*/gi,
  /(?<="apiKey":")(?:[^"\\]|\\.)*/gi,
  /(?<="token":")(?:[^"\\]|\\.)*/gi,
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
 * Scrubs whatever was logged under `err`.
 *
 * A message and a stack routinely quote the input that failed, and libraries attach whole request
 * objects as extra properties, so every property of a real error is walked rather than only the
 * top-level strings. Serialisation runs before the record formatter, so this is the only pass over
 * an error's fields.
 *
 * pino applies this serializer to the `err` key whatever its value is, so the declared parameter
 * type is the contract rather than a guarantee, and the value is treated as untrusted. pino's own
 * standard serializer hands anything it does not recognise as an error straight back; that value
 * is scrubbed and passed through unchanged instead of being walked as an error record, which would
 * throw on `null`, spread a string into one entry per character, and flatten a number to `{}`. A
 * rejection with a non-`Error` reason, logged as `{ err: reason }`, is exactly that case.
 *
 * @param error - Value logged under the `err` key; despite the type, not necessarily an `Error`.
 * @param redactor - Redactor applied to keys and values.
 * @returns A scrubbed error record, or the scrubbed value itself when it is not an error.
 */
function redactSerializedError(error: Error, redactor: LoggerRedactor): unknown {
  const serialized: unknown = pino.stdSerializers.err(error);
  // A new record means pino recognised an error and rebuilt it; anything else is the original
  // value, which is scrubbed but keeps its own shape.
  // Stryker disable next-line ConditionalExpression: the first question is the one that decides.
  // pino hands back the value it was given whenever it did not recognise an error, so a serialised
  // result that is not an object, or is null, is always that same value and has already been
  // answered. The two checks stay because they are what narrows `unknown` to something whose
  // entries can be read below.
  if (serialized === error || typeof serialized !== 'object' || serialized === null) {
    return redactor.redactJson(error);
  }
  // Serialisation runs *after* `formatters.log`, so this is the only structural pass over an
  // error's fields. The entries are copied into a plain object first: pino gives its error record
  // its own prototype, which the sensitive-field walk skips on purpose.
  return scrubRecord(Object.fromEntries(Object.entries(serialized)), redactor);
}

/** {@link SENSITIVE_FIELD_NAMES} folded to lower case, for case-insensitive key lookup. */
const SENSITIVE_FIELD_LOOKUP = new Set(SENSITIVE_FIELD_NAMES.map((name) => name.toLowerCase()));

/**
 * Replaces the value of every sensitive field with the censor token, whatever that value is.
 *
 * The value is replaced whole rather than walked into: an object or an array under `token` is a
 * credential with a wrapper around it, and blanking only the strings inside would still publish its
 * shape. This is a structural pass and not part of {@link Redactor.redactJson}, which answers a
 * different question — that one rewrites strings it recognises wherever they sit, this one removes
 * a whole subtree because of the name it hangs from.
 *
 * A value that is not a plain object or array is returned untouched; pino serialises those itself,
 * and the finished-line scrub is the net for them.
 *
 * @param value - Any value from a record, at any depth.
 * @param seen - Objects on the current path, so a cycle terminates.
 * @returns A new structure; the input is never mutated.
 */
function blankSensitiveFields(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return CIRCULAR_TOKEN;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    seen.add(value);
    const items: unknown[] = value.map((item: unknown) => blankSensitiveFields(item, seen));
    seen.delete(value);
    return items;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  seen.add(value);
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = SENSITIVE_FIELD_LOOKUP.has(key.toLowerCase())
      ? REDACTED_TOKEN
      : blankSensitiveFields(entry, seen);
  }
  seen.delete(value);
  return record;
}

/**
 * Blanks the value of every sensitive field name in a serialised record.
 *
 * `String.replace` with a global pattern resets the pattern's cursor itself, so the shared literals
 * carry no state between calls.
 *
 * @param line - Serialised record.
 * @returns The line with each sensitive field's string value replaced by the censor token.
 */
function blankSensitiveValues(line: string): string {
  let output = line;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED_TOKEN);
  }
  return output;
}

/**
 * Applies the last-resort scrub to a finished line, keeping the output parseable.
 *
 * @param line - Serialised record, newline terminated.
 * @param redactor - Redactor applied to the whole line.
 * @returns The scrubbed line, or a fixed notice when scrubbing broke the JSON.
 */
function redactLine(line: string, redactor: LoggerRedactor): string {
  const scrubbed = blankSensitiveValues(redactor.redact(line));
  // Stryker disable next-line ConditionalExpression,BlockStatement: an untouched line is returned
  // here rather than parsed and returned, which for a line this logger wrote is the same string
  // either way — pino writes nothing but valid JSON. What this saves is the parse, not a verdict.
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
 * Applies both structural passes to a record: sensitive fields are blanked by name, then every
 * remaining string is scrubbed by the redactor.
 *
 * @param record - Merged record or child bindings.
 * @param redactor - Redactor applied to keys and string values.
 * @returns The record with the same shape, minus anything sensitive.
 */
function scrubRecord(
  record: Record<string, unknown>,
  redactor: LoggerRedactor,
): Record<string, unknown> {
  const blanked = blankSensitiveFields(record, new WeakSet<object>());
  return redactor.redactJson(blanked) as Record<string, unknown>;
}

/**
 * Builds the pino options a redacting logger is created from.
 *
 * @param options - Level, redactor and optional name, base and destination.
 * @returns Options ready to hand to pino.
 */
function buildLoggerOptions(options: CreateLoggerOptions): LoggerOptions {
  const { redactor } = options;
  return {
    level: options.level,
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...LOG_REDACT_PATHS], censor: REDACTED_TOKEN },
    formatters: {
      // Both passes rebuild a plain object as a plain object, so the record keeps its shape and the
      // cast back from `unknown` holds by construction. Same for the bindings below.
      log: (record) => scrubRecord(record, redactor),
      bindings: (bindings) => scrubRecord(bindings, redactor),
    },
    serializers: {
      err: (error: Error) => redactSerializedError(error, redactor),
    },
    hooks: {
      logMethod(args, method) {
        // Scrubbing here reaches the message and the interpolation arguments, which pino merges
        // into `msg` after this hook and which no later layer could take apart again — once an
        // argument has been folded into the message it is text, so a sensitive field inside it has
        // to be blanked before that happens. The cast restores the tuple shape that `map` widens
        // to `unknown[]`.
        const scrubbed = args.map((argument: unknown) =>
          redactor.redactJson(blankSensitiveFields(argument, new WeakSet<object>())),
        );
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
      streamWrite: (line) => redactLine(line, redactor),
    },
    // Stryker disable next-line ConditionalExpression: a name that is not given would be spread in
    // as `undefined`, which pino leaves out of the record exactly as an absent key does; the
    // conditional says what is meant rather than relying on that.
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

/**
 * Returns a logger whose `child` scrubs its bindings, and whose grandchildren do the same.
 *
 * pino calls `formatters.bindings` only for the base bindings handed to the factory, never for the
 * ones passed to `child`, and its own `redact` paths reach child bindings with the same
 * case-sensitivity and one-level limit as everywhere else. Without this, a credential parked in a
 * child binding would have nothing but the finished-line scrub in front of it, which cannot reach
 * inside an object value. Verified against pino 10.
 *
 * @param logger - Logger to wrap.
 * @param redactor - Redactor applied to the bindings.
 * @returns The same logger, with `child` replaced.
 */
function withScrubbedChildren(logger: Logger, redactor: LoggerRedactor): Logger {
  const createChild = logger.child.bind(logger);
  const scrubbedChild = (bindings: Bindings, childOptions?: ChildLoggerOptions): Logger =>
    withScrubbedChildren(createChild(scrubRecord(bindings, redactor), childOptions), redactor);
  // Defined rather than assigned because `child` is declared generic over the child's custom
  // levels; the replacement keeps the runtime contract exactly — same arguments, a real child
  // logger back — and only rewrites the bindings on the way in.
  // Nothing assigns over `child` and nothing defines it on the same logger twice — each call here
  // is handed a logger pino has just built — so neither permission below is ever exercised. They
  // are stated because a property left frozen by accident is a trap for whoever wraps this next.
  Object.defineProperty(logger, 'child', {
    value: scrubbedChild,
    // Stryker disable next-line BooleanLiteral: see above; no assignment to `child` exists.
    writable: true,
    // Stryker disable next-line BooleanLiteral: see above; no second definition on one logger.
    configurable: true,
  });
  return logger;
}

/**
 * Creates a logger that cannot print a credential.
 *
 * @param options - Level, redactor and optional name, base and destination.
 * @returns A pino logger writing to the given destination, or to standard output.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions = buildLoggerOptions(options);
  const logger =
    // Stryker disable next-line ConditionalExpression: pino falls back to standard output when the
    // stream argument is `undefined`, so passing it through unconditionally lands in the same
    // place; the branch states the intent rather than leaning on that.
    options.destination === undefined
      ? pino(loggerOptions)
      : pino(loggerOptions, options.destination);
  return withScrubbedChildren(logger, options.redactor);
}
