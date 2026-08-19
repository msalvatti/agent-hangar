/**
 * The redactor: removes credentials from text and JSON before anything is logged, persisted or
 * published.
 *
 * Layer: utility (pure).
 *
 * Two independent mechanisms run on every value. Registered values catch the exact credentials
 * this process revealed, in their raw form and in the encodings they acquire on the way into a
 * URL or a JSON document. Shape patterns catch anything that merely looks like a credential —
 * including tokens this process never saw, such as one the agent printed from its own
 * environment. Neither layer needs the caller to know which fields are sensitive.
 *
 * Redaction is idempotent: the replacement token matches no pattern, and a value that is a
 * substring of the token is refused at registration, so re-redacting redacted output is a no-op.
 *
 * Values that are neither strings, plain objects nor arrays — class instances, `Map`, `Set`,
 * `Date`, typed arrays — are returned unchanged by {@link Redactor.redactJson}. Never place a
 * credential inside one and expect it to be scrubbed.
 */
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../secrets/types.js';
import type { Redactor } from '../secrets/types.js';

/** Shortest value that may be registered; anything shorter would match ordinary prose. */
export const MIN_REGISTERED_LENGTH = 4;

/** Written in place of an object that refers back to itself. */
export const CIRCULAR_TOKEN = '[Circular]';

/** Characters that carry meaning inside a regular expression. */
const REGEXP_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\/]/g;

/** Construction options of {@link createRedactor}. */
export interface RedactorOptions {
  /** Shape patterns to apply; defaults to `SECRET_SHAPE_PATTERNS`. */
  patterns?: readonly RegExp[];
  /** Token written in place of a match; defaults to `REDACTED_TOKEN`. */
  replacement?: string;
}

/** A {@link Redactor} whose registered values can also be forgotten again. */
export interface RegisteringRedactor extends Redactor {
  /** Forgets every registered value. Shape patterns stay active. */
  clear(): void;
}

/**
 * Escapes a value so it can be embedded in a regular expression as a literal.
 *
 * @param value - Text to quote.
 * @returns The value with every regular-expression metacharacter backslash-escaped.
 */
export function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL_CHARACTERS, '\\$&');
}

/**
 * Replaces every match of a pattern in a string.
 *
 * The patterns come from a frozen contract and carry no flags, so they are used as they are:
 * nothing is recompiled from a non-literal source, and a pattern that does carry `g` or `y` has
 * its cursor reset before each search instead of leaking position state between calls. A pattern
 * that can match the empty string would never advance, so the search stops there and returns the
 * rest of the input untouched.
 *
 * @param input - Text to scan.
 * @param pattern - Pattern to look for.
 * @param replacement - Token written in place of each match.
 * @returns The text with every match replaced.
 */
function replaceEvery(input: string, pattern: RegExp, replacement: string): string {
  let output = '';
  let rest = input;
  for (;;) {
    if (pattern.global || pattern.sticky) {
      pattern.lastIndex = 0;
    }
    const match = pattern.exec(rest);
    if (match === null || match[0].length === 0) {
      return output + rest;
    }
    output += rest.slice(0, match.index) + replacement;
    rest = rest.slice(match.index + match[0].length);
  }
}

/**
 * Reports whether a value is a bare record rather than an instance of some class.
 *
 * @param value - Any object.
 * @returns `true` for object literals and null-prototype objects.
 */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Creates a redactor over a set of shape patterns.
 *
 * @param options - Patterns and replacement token; both default to the frozen contract values.
 * @returns A redactor that starts with no registered values.
 */
export function createRedactor(options: RedactorOptions = {}): RegisteringRedactor {
  const replacement = options.replacement ?? REDACTED_TOKEN;
  const patterns = options.patterns ?? SECRET_SHAPE_PATTERNS;
  const registered = new Set<string>();
  let longestFirst: string[] = [];

  /**
   * Adds one spelling of a credential to the registry.
   *
   * @param value - Exact text to look for.
   */
  function remember(value: string): void {
    if (value.length >= MIN_REGISTERED_LENGTH && !replacement.includes(value)) {
      registered.add(value);
    }
  }

  /**
   * Replaces registered values and shape matches in a string.
   *
   * @param input - Text to scrub.
   * @returns The text with every credential replaced.
   */
  function redact(input: string): string {
    let output = input;
    for (const value of longestFirst) {
      output = output.split(value).join(replacement);
    }
    for (const pattern of patterns) {
      output = replaceEvery(output, pattern, replacement);
    }
    return output;
  }

  /**
   * Walks a JSON-like value, scrubbing keys and strings.
   *
   * @param value - Value to scrub.
   * @param ancestors - Objects currently being walked, for cycle detection.
   * @returns A new structure; the input is never mutated.
   */
  function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
    if (typeof value === 'string') {
      return redact(value);
    }
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    if (ancestors.has(value)) {
      return CIRCULAR_TOKEN;
    }
    if (Array.isArray(value)) {
      ancestors.add(value);
      const items: unknown[] = value.map((item: unknown) => redactValue(item, ancestors));
      ancestors.delete(value);
      return items;
    }
    if (!isPlainObject(value)) {
      return value;
    }
    ancestors.add(value);
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[redact(key)] = redactValue(entry, ancestors);
    }
    ancestors.delete(value);
    return record;
  }

  return {
    register(values: readonly string[]): void {
      for (const value of values) {
        remember(value);
        // A credential keeps its identity through the encodings it meets on the way out: inside a
        // clone URL, and inside a JSON string that escapes quotes or backslashes.
        remember(encodeURIComponent(value));
        remember(JSON.stringify(value).slice(1, -1));
      }
      longestFirst = [...registered].sort((left, right) => right.length - left.length);
    },

    clear(): void {
      registered.clear();
      longestFirst = [];
    },

    redact,

    redactJson(input: unknown): unknown {
      return redactValue(input, new WeakSet<object>());
    },
  };
}
