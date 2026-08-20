/**
 * Forwarding a file of scripted model responses into the workspace container.
 *
 * Layer: config.
 *
 * `AGENT_MODEL_PROVIDER=fake` selects a provider that answers from a script instead of calling a
 * model, which is how the whole pipeline — containers, git, Postgres, streams — is exercised
 * without an API key or a network call. That provider runs inside the workspace container and
 * reads its script from `AGENT_FAKE_SCRIPT_JSON`, a variable carrying the script itself; a caller
 * that wants to supply one has a file, and a path on this side would not resolve on that side
 * anyway. This module is the join: it reads the file, validates it against the event union the
 * provider will replay, and returns the container variable carrying it.
 *
 * The scripted provider is the only way in. A script decides what the agent says and which tools
 * it calls with which arguments, so forwarding one whenever a path happened to be set would turn
 * an environment variable into a way of making a real agent do arbitrary things. The provider
 * name is therefore part of the decision here rather than a check somewhere else, and a run that
 * has not selected the scripted provider adds nothing to the container environment.
 *
 * Security: the forwarded value carries no credential. It is the file's own content, reserialised
 * from the validated script so that nothing the schema does not declare travels with it, and the
 * placeholder a scripted step may use for the workspace's GitHub credential is substituted inside
 * the container, where that credential already lives. The script is never logged, and a refusal
 * quotes none of its values: a message names the path, and the position in the file that is
 * wrong, and nothing more.
 */
import { readFileSync } from 'node:fs';

import { ConfigError } from '@agent-hangar/core';
import type { AppConfig } from '@agent-hangar/core';
import { z } from 'zod';

/**
 * The file-system operations this module needs.
 *
 * Injected rather than called directly, as the master key file does for the same reason: the
 * failure that matters here — a path that names nothing readable — is then a property of the test
 * rather than of the machine it runs on.
 */
export interface ScriptFileSystem {
  /** Reads a whole file as text. */
  readFileSync: typeof readFileSync;
}

/** The process's own file system. */
export const nodeScriptFileSystem: ScriptFileSystem = { readFileSync };

/** Variable the scripted provider inside the workspace container reads its script from. */
export const FAKE_SCRIPT_ENV_KEY = 'AGENT_FAKE_SCRIPT_JSON';

/** Token usage a scripted response reports when it completes. */
const modelUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/**
 * The provider's event union, restated as a schema.
 *
 * The container replays these verbatim, and everything downstream of it — the persisted messages,
 * the tool-call rows, the event stream the browser reads — is built from them. A script that does
 * not match is therefore refused before a container is ever created, where the operator can still
 * read the message, rather than half-played inside one.
 */
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
  z.object({ type: z.literal('response.done'), responseId: z.string().min(1), usage: modelUsage }),
  z.object({
    type: z.literal('error'),
    code: z.enum(['rate_limit', 'auth', 'context_length', 'network', 'unknown']),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);

/** One model round-trip: the events it yields, and an optional delay before the first of them. */
const scriptedStep = z.object({
  events: z.array(modelEvent).min(1),
  delayMs: z.number().int().nonnegative().optional(),
});

/** Steps keyed by the exact text of the last user message, plus a `default` key. */
const providerScript = z.record(z.string(), z.array(scriptedStep).min(1));

/** A validated script: steps to replay, keyed by the message that selects them. */
export type FakeProviderScript = z.infer<typeof providerScript>;

/**
 * Renders the reasons a script was refused, from the schema's report and nothing else.
 *
 * A position and the schema's own wording, never a value the file carried: this text ends up in a
 * boot failure that is written to the log, and the file is operator-supplied content.
 *
 * @param error - What the schema reported.
 * @returns One indented line per problem.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

/**
 * Reads and validates the script file.
 *
 * The path is configuration, read once at boot and never derived from a request; what the file
 * may then contain is decided by the schema rather than by whoever wrote it.
 *
 * @param path - Absolute path of the JSON file, from `FAKE_PROVIDER_SCRIPT_PATH`.
 * @param fileSystem - Where the file is read from; defaults to the process's own.
 * @returns The validated script.
 * @throws ConfigError when the file cannot be read, is not JSON, or is not a script.
 */
export function readFakeProviderScript(
  path: string,
  fileSystem: ScriptFileSystem = nodeScriptFileSystem,
): FakeProviderScript {
  let raw: string;
  try {
    raw = fileSystem.readFileSync(path, 'utf8');
  } catch {
    // The reason is not repeated: it is a message about a path the operator supplied, and the
    // path is already named.
    throw new ConfigError(`FAKE_PROVIDER_SCRIPT_PATH: cannot read ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A JSON parse error quotes a prefix of its input, which is the file's content.
    throw new ConfigError(`FAKE_PROVIDER_SCRIPT_PATH: ${path} is not valid JSON`);
  }
  const result = providerScript.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `FAKE_PROVIDER_SCRIPT_PATH: ${path} is not a provider script:\n${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Builds the container variables that carry a supplied script, if there is one to carry.
 *
 * @param provider - The configured model provider; only the scripted one may be given a script.
 * @param path - `FAKE_PROVIDER_SCRIPT_PATH`, when the environment sets it.
 * @returns The variables to add to a workspace container's environment; empty when none apply.
 * @throws ConfigError when a script was named but cannot be read or is not a script.
 */
export function fakeProviderScriptEnv(
  provider: AppConfig['AGENT_MODEL_PROVIDER'],
  path: string | undefined,
): Record<string, string> {
  if (provider !== 'fake' || path === undefined) {
    return {};
  }
  return { [FAKE_SCRIPT_ENV_KEY]: JSON.stringify(readFakeProviderScript(path)) };
}
