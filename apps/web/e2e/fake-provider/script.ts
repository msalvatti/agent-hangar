/**
 * Schema and loader for the scripted responses the fake model provider plays during a real-stack
 * run.
 *
 * Layer: test support (pure).
 *
 * The script is data rather than code because the provider that plays it runs inside the workspace
 * container, which the suite does not import. Nothing loads it there yet: the container receives
 * only the fixed environment block the worker builds, and the provider takes its script from
 * `AGENT_FAKE_SCRIPT_JSON`, which carries the script itself rather than a path. So what this
 * module gives today is the shape the script must have and the substitution its one placeholder
 * needs, both pinned by tests, and the file is inert until the worker forwards it.
 *
 * No credential-shaped literal is written into the file. The one step whose arguments must carry
 * a credential — so the suite can prove the worker redacts it before persisting — writes the
 * placeholder below instead, for the canary to be substituted at the point the script is loaded.
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
const modelEvent = z.discriminatedUnion('type', [
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
const scriptedStep = z.object({
  events: z.array(modelEvent).min(1),
  delayMs: z.number().int().nonnegative().optional(),
});

/** Steps keyed by the exact text of the last user message, plus a `default` key. */
const providerScript = z.record(z.string(), z.array(scriptedStep).min(1));

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
