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
 * What counts as a credential here is {@link REDACTION_PATTERNS}: the shapes of the secrets
 * contract, plus the password a connection URL carries in its userinfo. The second one is what a
 * process leaks about *itself* rather than about its user — see that constant for why it is
 * policy and where the policy stops.
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

/**
 * The password of a URL that carries one, as `scheme://user:password@host`.
 *
 * The match is bounded by the authority's structure rather than by a list of characters a password
 * may not contain, because the WHATWG parser — the one `z.url()` validates `DATABASE_URL` and
 * `REDIS_URL` with — admits far more in userinfo than a hand-written class tends to allow. It takes
 * `[`, `]`, `"`, a space and even a raw `@` and percent-encodes them itself, and it keeps the value
 * the operator wrote: `z.url()` returns its input unchanged, so what flows through the process and
 * into any record is the raw spelling, brackets and all. A class that excluded them would leave
 * exactly those passwords in the log.
 *
 * So the right edge is the last `@` before the authority ends, which is the parser's own rule for
 * where userinfo stops — greedy matching to the final `@` reproduces it, and a password containing
 * an `@` is therefore covered rather than truncated. `/`, `?` and `#` end the authority, and a URL
 * that carries one of them raw in its userinfo is rejected outright by the parser, so excluding
 * them costs no real password and is what stops a match running from one URL's userinfo into a
 * later `@` in a path or a query.
 *
 * Two characters are still excluded, and each is a price paid for a property rather than an
 * oversight. Whitespace: without it one match could run from a URL across a whole log line to some
 * distant `@`, redacting everything in between. A bare `"`: it is what separates one field of a
 * serialised record from the next, and a match that crossed it would swallow the fields between —
 * producing valid JSON with a field silently missing, which is worse than a line that fails to
 * parse. Inside a JSON string a real quote arrives escaped, so only a boundary quote is ever bare.
 *
 * What that costs, stated plainly: a password containing a raw quote or a raw space is left alone
 * by this rule. The complete answer for a password of any shape is not a pattern at all — it is
 * registering the configured value at boot, which catches it in every spelling and is the same
 * mechanism the forge token already uses.
 *
 * Idempotence no longer rests on the replacement token's brackets being unmatchable, and this is
 * the part worth not re-deriving: the token contains no `@`, and after a substitution it sits
 * immediately before the `@` the match ended at, so a second pass lands on that same `@`, matches
 * exactly the token, and writes it back unchanged. The output is identical, not merely equivalent.
 */
export const URL_PASSWORD_PATTERN = /(?<=:\/\/[^\s/:@]*:)[^\s/"?#]+(?=@)/;

/**
 * What every redactor built here treats as a credential.
 *
 * `SECRET_SHAPE_PATTERNS` is the contract's answer for credentials that travel as *content*: a
 * token the model quoted, a header the agent echoed. It says nothing about the password inside
 * `DATABASE_URL` or `REDIS_URL`, which is not content at all — it is the process's own
 * configuration, and nothing registers it: the web process never reveals a stored secret, so it
 * hands the redactor no values, and a bare password matches no token shape. Shape is the only
 * layer in front of it.
 *
 * Measured, so the reason here is not folklore: the drivers this project uses do not put the
 * connection string in what they throw. `pg`, `@prisma/adapter-pg` and `ioredis` all report a
 * refused connection, an unreachable host and an unparseable URL without the URL appearing in the
 * message, the stack or any enumerable property. What makes the rule worth having is not one
 * driver's habit but the shape of the defence: the configured URL is an ordinary string held by
 * both processes, redaction here is structural rather than something a call site remembers, and a
 * record that carries that string reaches the output through whichever path nobody thought about.
 *
 * Widening "credential" to cover it is a deliberate policy choice with a cost: a URL password
 * becomes unreadable in a log from now on, including one an operator put there on purpose. That is
 * the right trade, because a connection URL's password is never the thing a log line is about.
 *
 * The bare password on its own — named without the URL around it — stays out of reach here,
 * because a password has no shape. Closing that, and the two userinfo spellings
 * {@link URL_PASSWORD_PATTERN} sells, means registering the value at boot in every process that
 * holds one.
 */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  ...SECRET_SHAPE_PATTERNS,
  URL_PASSWORD_PATTERN,
];

/** Construction options of {@link createRedactor}. */
export interface RedactorOptions {
  /** Shape patterns to apply; defaults to {@link REDACTION_PATTERNS}. */
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
 * @param options - Patterns and replacement token; they default to {@link REDACTION_PATTERNS} and
 * to the contract's replacement token.
 * @returns A redactor that starts with no registered values.
 */
export function createRedactor(options: RedactorOptions = {}): RegisteringRedactor {
  const replacement = options.replacement ?? REDACTED_TOKEN;
  const patterns = options.patterns ?? REDACTION_PATTERNS;
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
