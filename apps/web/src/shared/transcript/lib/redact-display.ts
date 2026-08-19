/**
 * Defence-in-depth masking of secret-shaped text before it reaches the DOM.
 *
 * Layer: shared (formatting).
 *
 * The worker already redacts before persisting or publishing (spec 07). This module exists so a
 * bug elsewhere in the pipeline — a raw event replayed, a fixture misused — cannot still render a
 * credential: every string handed to a transcript component passes through here first.
 */
import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '@agent-hangar/core';

/**
 * Replaces every match of {@link SECRET_SHAPE_PATTERNS} with `[REDACTED]`.
 *
 * @param text - Text that may contain a secret-shaped substring.
 * @returns `text` with every match replaced.
 */
function maskAllMatches(text: string, pattern: RegExp): string {
  let masked = text;
  // `SECRET_SHAPE_PATTERNS` entries carry no `g` flag (a shared global regex is stateful), so
  // every match is replaced one at a time instead of constructing a new global regex per call.
  while (pattern.test(masked)) {
    masked = masked.replace(pattern, REDACTED_TOKEN);
  }
  return masked;
}

export function maskSecretShapes(text: string): string {
  return SECRET_SHAPE_PATTERNS.reduce((masked, pattern) => maskAllMatches(masked, pattern), text);
}

/**
 * Pretty-prints a value as JSON (2-space indent) with secret shapes masked, falling back to
 * `String(value)` when the value cannot be serialized (e.g. it contains a circular reference).
 *
 * @param value - Value to display (tool call arguments, results).
 * @returns The masked, pretty-printed text.
 */
export function toDisplayJson(value: unknown): string {
  try {
    // The lib types claim `JSON.stringify` always returns `string`, but it actually returns
    // `undefined` for a top-level `undefined`, function, or symbol — the cast makes that real
    // case visible to the type checker instead of masking it as an "impossible" fallback.
    const serialized = JSON.stringify(value, null, 2) as string | undefined;
    return maskSecretShapes(serialized ?? String(value));
  } catch {
    return maskSecretShapes(String(value));
  }
}
