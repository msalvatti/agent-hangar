/**
 * Runtime-side redaction of everything the container writes out.
 *
 * Layer: utility.
 *
 * The runtime is the only process that sees the GitHub PAT and the OpenAI key in plaintext, and
 * everything it emits (events on stdout, diagnostics on stderr) is persisted and displayed. Two
 * passes therefore run over every string: the exact values present in the runtime's own
 * environment, then the shape patterns of the secrets contract, which also catch a credential the
 * agent produced itself — a token it printed from a file, or an `Authorization` header it echoed.
 *
 * The worker redacts again before persisting; this pass exists so a leak never reaches the pipe
 * in the first place.
 */
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';

/** Replacement written in place of a secret; the token shared with the host-side redactor. */
export const REDACTED = REDACTED_TOKEN;

/**
 * Shortest exact value that is worth replacing.
 *
 * A short environment value is far more likely to be an ordinary word that happens to sit in
 * `GITHUB_TOKEN` during a test than a credential, and replacing it would corrupt unrelated text.
 * Real PATs and API keys are dozens of characters long.
 */
const MIN_EXACT_VALUE_LENGTH = 8;

/** Removes secrets from text and from the text-carrying fields of protocol events. */
export interface RuntimeRedactor {
  /** Replaces registered values and shape-pattern matches with {@link REDACTED}. Idempotent. */
  redactText(text: string): string;
  /** Returns a copy of `event` with every text-carrying field redacted. */
  redactEvent(event: AgentEvent): AgentEvent;
}

/** Options of {@link createRuntimeRedactor}. */
export interface RuntimeRedactorOptions {
  /** Live secret values, typically `GITHUB_TOKEN` and `OPENAI_API_KEY` from the container env. */
  values?: readonly (string | undefined)[];
}

/**
 * Keeps the values worth replacing, longest first.
 *
 * Longest-first matters when one value contains another: replacing the shorter one first would
 * leave the remainder of the longer one in the output.
 *
 * @param values - Raw candidates, possibly undefined or empty.
 * @returns Distinct values of usable length, ordered by descending length.
 */
function usableValues(values: readonly (string | undefined)[]): string[] {
  const kept = new Set<string>();
  for (const value of values) {
    if (value !== undefined && value.length >= MIN_EXACT_VALUE_LENGTH) {
      kept.add(value);
    }
  }
  return [...kept].sort((a, b) => b.length - a.length);
}

/**
 * Serialises a value the way `JSON.stringify` really behaves.
 *
 * The standard library types the return as `string`, but a value with no JSON form (`undefined`,
 * a function, a symbol) yields `undefined`. Declaring the honest type here keeps the caller's
 * guard meaningful instead of looking like dead code.
 *
 * @param value - Any value.
 * @returns The JSON text, or `undefined` when the value has no JSON form.
 */
function toJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

/**
 * Redacts an event's `args`, which the model produced and may be any JSON value.
 *
 * Redaction runs over the serialised form so a secret is caught wherever it sits in the
 * structure. A replacement can straddle a JSON delimiter (the `Bearer` pattern consumes
 * non-space characters, including a closing quote), so the reparse is allowed to fail and the
 * redacted text is then reported as-is — losing the structure, never the containment.
 *
 * @param args - Arguments as decoded from the model's tool call.
 * @param redactText - Text redactor to apply.
 * @returns The redacted arguments, or the redacted JSON text when it no longer parses.
 */
function redactArgs(args: unknown, redactText: (text: string) => string): unknown {
  const json = toJson(args);
  if (json === undefined) {
    // `undefined`, functions and symbols have no JSON form and carry no text to redact.
    return args;
  }
  const redacted = redactText(json);
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    return redacted;
  }
}

/**
 * Creates a redactor bound to a set of live secret values.
 *
 * @param options - Exact values to replace on top of the shape patterns.
 * @returns A redactor for text and for protocol events.
 */
export function createRuntimeRedactor(options: RuntimeRedactorOptions = {}): RuntimeRedactor {
  const values = usableValues(options.values ?? []);

  // Both passes use `split`/`join` rather than `replace`. For an exact value it sidesteps the
  // escaping bugs a pattern built from the value would introduce; for a shape pattern it replaces
  // every occurrence without the global flag the contract deliberately withholds — `split` matches
  // repeatedly on its own and leaves the shared pattern's state untouched.
  const redactText = (text: string): string => {
    let output = text;
    for (const value of values) {
      output = output.split(value).join(REDACTED);
    }
    for (const pattern of SECRET_SHAPE_PATTERNS) {
      output = output.split(pattern).join(REDACTED);
    }
    return output;
  };

  return {
    redactText,
    redactEvent(event) {
      switch (event.type) {
        case 'prepare.progress':
          return { ...event, message: redactText(event.message) };
        case 'assistant.delta':
        case 'assistant.message':
        case 'tool.output.delta':
          return { ...event, text: redactText(event.text) };
        case 'tool.call':
          return { ...event, args: redactArgs(event.args, redactText) };
        case 'turn.completed':
          return { ...event, finalMessage: redactText(event.finalMessage) };
        case 'turn.failed':
          return { ...event, error: { ...event.error, message: redactText(event.error.message) } };
        // Variants below carry only machine-generated fields: identifiers, counts, statuses,
        // timestamps and git object names. Listing them keeps a new protocol event from slipping
        // past this boundary unexamined.
        case 'turn.started':
        case 'prepare.done':
        case 'step.started':
        case 'tool.result':
        case 'git.pushed':
        case 'heartbeat':
        case 'turn.cancelled':
        case 'protocol.error':
          return event;
      }
    },
  };
}
