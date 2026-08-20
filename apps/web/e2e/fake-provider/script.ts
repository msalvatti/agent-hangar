/**
 * Schema and loader for the scripted responses the fake model provider plays during a real-stack
 * run.
 *
 * Layer: test support (pure).
 *
 * The script is data rather than code because the provider runs inside the worker process, which
 * the suite does not import: the worker is pointed at this file through
 * `FAKE_PROVIDER_SCRIPT_PATH` and parses it into the `ProviderScript` shape the fake provider
 * already takes.
 *
 * No credential-shaped literal is written into the file. The one step whose arguments must carry
 * a credential — so the suite can prove the worker redacts it before persisting — writes the
 * placeholder below instead, and the loader substitutes the canary at run time.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** Placeholder standing in for the GitHub canary inside the script file. */
export const GITHUB_CANARY_PLACEHOLDER = '{{GITHUB_CANARY}}';

/** Token usage every scripted response reports. */
const usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/** Mirror of the core `ModelEvent` union, so a malformed script fails here and not in the worker. */
export const modelEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text.delta'), text: z.string() }),
  z.object({ type: z.literal('text.done'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    callId: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string().min(1),
  }),
  z.object({
    type: z.literal('tool_call.arguments.delta'),
    callId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({ type: z.literal('response.done'), responseId: z.string().min(1), usage }),
  z.object({
    type: z.literal('error'),
    code: z.enum(['rate_limit', 'auth', 'context_length', 'network', 'unknown']),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

/** One model round-trip. */
export const scriptedStep = z.object({
  events: z.array(modelEvent).min(1),
  delayMs: z.number().int().nonnegative().optional(),
});

/** Steps keyed by the exact text of the last user message, plus a `default` key. */
export const providerScript = z.record(z.string(), z.array(scriptedStep).min(1));

/** The parsed script. */
export type ProviderScriptFile = z.infer<typeof providerScript>;

/**
 * Absolute path of the script shipped with the suite.
 *
 * Derived with `node:path` rather than a `new URL` against `import.meta.url`, which the bundler
 * rewrites as an asset reference.
 */
export function scriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'script.json');
}

/**
 * Reads and validates the script file.
 *
 * @param path - Path of the JSON file (defaults to the one shipped with the suite).
 * @returns The parsed script.
 * @throws Error when the file is missing or does not match the schema.
 */
export function loadProviderScript(path: string = scriptPath()): ProviderScriptFile {
  return providerScript.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Replaces every placeholder with its real value.
 *
 * @param raw - Text of the script file.
 * @param values - Placeholder-to-value pairs.
 * @returns The text with every placeholder substituted.
 */
export function substitutePlaceholders(
  raw: string,
  values: Readonly<Record<string, string>>,
): string {
  return Object.entries(values).reduce(
    (text, [placeholder, value]) => text.replaceAll(placeholder, value),
    raw,
  );
}
