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
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../secrets/types.ts';
import type { Redactor } from '../secrets/types.ts';

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
 * Finds the first match of a pattern anywhere in the input, wherever its cursor happens to be.
 *
 * A sticky pattern matches only at `lastIndex`, so asking it once from position 0 answers "is
 * there a match *here*", not "is there a match at all" — and it reports nothing for a credential
 * that sits further along, which `split` would have found and replaced. The positions are
 * therefore walked for a sticky pattern, which costs a scan of the input but only for a pattern
 * that opted into stickiness; none of the contract patterns do.
 *
 * @param input - Text to scan.
 * @param pattern - Pattern to look for; its cursor is moved and the caller resets it.
 * @returns The first match, or `null` when the pattern matches nowhere in the input.
 */
function firstMatch(input: string, pattern: RegExp): RegExpExecArray | null {
  if (!pattern.sticky) {
    pattern.lastIndex = 0;
    return pattern.exec(input);
  }
  for (let start = 0; start <= input.length; start += 1) {
    pattern.lastIndex = start;
    const match = pattern.exec(input);
    if (match !== null) {
      return match;
    }
  }
  return null;
}

/**
 * Replaces every match of a pattern in a string, whether or not the pattern carries `g`.
 *
 * `String.prototype.split` finds every match itself, against the whole input and independently of
 * the pattern's own flags and cursor. That is what makes this equivalent to a global replace:
 * anchors and lookarounds are evaluated against the real input, not against a progressively
 * shortened copy of it, so `/^token/` matches only at the start of the input as it should.
 * Scanning a substring instead would re-satisfy `^` at every step and redact text that the
 * pattern never actually matched. Nothing is recompiled from a non-literal source.
 *
 * `split` also emits the capture groups of each match between the surrounding pieces. Joining
 * those back in would write captured — possibly secret — text into the output, so only every
 * `1 + groups`-th piece is kept and the captures are dropped.
 *
 * A pattern that can match the empty string would match between every pair of characters and turn
 * the whole input into replacement tokens, so it is refused and the input is returned untouched.
 *
 * @param input - Text to scan.
 * @param pattern - Pattern to look for; the caller keeps ownership of it, so its `lastIndex` is
 * reset on the way in and on the way out and no position state survives the call.
 * @param replacement - Token written in place of each match.
 * @returns The text with every match replaced.
 */
function replaceEvery(input: string, pattern: RegExp, replacement: string): string {
  const probe = firstMatch(input, pattern);
  if (pattern.global || pattern.sticky) {
    // `exec` moves the cursor of a global or sticky pattern; `split` builds its own copy, so
    // clearing it here leaves the caller's pattern exactly as it was handed over.
    pattern.lastIndex = 0;
  }
  if (probe === null || probe[0].length === 0) {
    return input;
  }
  // `exec` returns the whole match plus one entry per capture group, which is exactly the stride
  // `split` uses between the pieces that surround each match: every stride-th piece is text that
  // was not matched, and everything between them is a capture to drop.
  const stride = probe.length;
  return input
    .split(pattern)
    .filter((_piece, index) => index % stride === 0)
    .join(replacement);
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
 * Adds one spelling of a credential to a registry.
 *
 * Values shorter than {@link MIN_REGISTERED_LENGTH} would match ordinary prose, and a value that
 * occurs inside the replacement token would make redaction non-idempotent; both are ignored so a
 * caller can register whatever it revealed without inspecting it first.
 *
 * @param registry - Set of exact values to look for.
 * @param replacement - Token written in place of a match.
 * @param value - Exact text to look for.
 */
function remember(registry: Set<string>, replacement: string, value: string): void {
  if (value.length >= MIN_REGISTERED_LENGTH && !replacement.includes(value)) {
    registry.add(value);
  }
}

/**
 * Walks a JSON-like value, scrubbing keys and strings.
 *
 * @param value - Value to scrub.
 * @param redact - String redaction function.
 * @param ancestors - Objects on the current path, for cycle detection.
 * @returns A new structure; the input is never mutated.
 */
function redactValue(
  value: unknown,
  redact: (input: string) => string,
  ancestors: WeakSet<object>,
): unknown {
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
    const items: unknown[] = value.map((item: unknown) => redactValue(item, redact, ancestors));
    ancestors.delete(value);
    return items;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  ancestors.add(value);
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[redact(key)] = redactValue(entry, redact, ancestors);
  }
  ancestors.delete(value);
  return record;
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

  const redact = (input: string): string => {
    let output = input;
    for (const value of longestFirst) {
      output = output.split(value).join(replacement);
    }
    for (const pattern of patterns) {
      output = replaceEvery(output, pattern, replacement);
    }
    return output;
  };

  return {
    register(values: readonly string[]): void {
      for (const value of values) {
        // A credential keeps its identity through the encodings it meets on the way out: inside a
        // clone URL, and inside a JSON string that escapes quotes or backslashes.
        remember(registered, replacement, value);
        remember(registered, replacement, encodeURIComponent(value));
        remember(registered, replacement, JSON.stringify(value).slice(1, -1));
      }
      longestFirst = [...registered].sort((left, right) => right.length - left.length);
    },

    clear(): void {
      registered.clear();
      longestFirst = [];
    },

    redact,

    redactJson(input: unknown): unknown {
      return redactValue(input, redact, new WeakSet<object>());
    },
  };
}
