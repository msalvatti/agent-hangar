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
 * The script travels as one environment variable, and `execve` bounds how long one of those may
 * be, so an oversized script is refused here rather than at the point a container's process
 * fails to start.
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

/**
 * Bytes `execve` allows one environment string to occupy, as a floor across platforms.
 *
 * `MAX_ARG_STRLEN` is 32 pages, so 131 072 on a 4 KiB page and more where pages are larger. The
 * smaller figure is therefore the one to plan against. It bounds the whole `KEY=VALUE` string,
 * not the value, which is why the key and the `=` are measured with it below.
 */
const PLATFORM_ENV_STRING_LIMIT_BYTES = 131_072;

/**
 * Bytes left unused below that ceiling.
 *
 * The bound sits a quarter of the budget short of the platform's own, so a value merely close to
 * the ceiling is refused here — where the file can be named — instead of being forwarded to
 * produce the failure worth avoiding: a container that is created and then cannot start its
 * process, reported as an `execve` error that names nothing this module knows about. A quarter is
 * a wide margin on purpose; a script anywhere near this size is a mistake rather than a use case,
 * so the unused space costs nothing real.
 */
const ENV_STRING_HEADROOM_BYTES = 32_768;

/** Largest `AGENT_FAKE_SCRIPT_JSON=…` assignment this will build, in bytes. */
export const MAX_FAKE_SCRIPT_ENV_BYTES =
  PLATFORM_ENV_STRING_LIMIT_BYTES - ENV_STRING_HEADROOM_BYTES;

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
 * Refuses a script the workspace process could not be started with.
 *
 * What is measured is the UTF-8 byte length of the whole assignment — the variable name, the `=`
 * and the reserialised script — because that is the string `execve` bounds. Not the character
 * count, which understates every non-ASCII script, and not the size of the file on disk, which is
 * a different string: the file's whitespace is dropped and what travels is the validated script
 * serialised again, so a file can be much larger or a little smaller than the value it produces.
 *
 * Refusing here is the point of reading at boot. The alternative is a container that is created
 * and then cannot start its process, reported as an `execve` failure that names nothing about a
 * script, on every turn the worker accepts.
 *
 * @param path - Path the script was read from, for the message.
 * @param value - The reserialised script about to be assigned.
 * @throws ConfigError naming the variable, the path, the size and the limit — never a value.
 */
function assertScriptFitsEnvironment(path: string, value: string): void {
  const bytes = Buffer.byteLength(`${FAKE_SCRIPT_ENV_KEY}=${value}`, 'utf8');
  if (bytes > MAX_FAKE_SCRIPT_ENV_BYTES) {
    throw new ConfigError(
      `FAKE_PROVIDER_SCRIPT_PATH: ${path} is too large to pass to a workspace container: ` +
        `${String(bytes)} bytes as ${FAKE_SCRIPT_ENV_KEY}=…, over the ` +
        `${String(MAX_FAKE_SCRIPT_ENV_BYTES)} bytes allowed here, which is the margin kept below ` +
        `the platform's own cap on one environment string.`,
    );
  }
}

/**
 * Builds the container variables that carry a supplied script, if there is one to carry.
 *
 * @param provider - The configured model provider; only the scripted one may be given a script.
 * @param path - `FAKE_PROVIDER_SCRIPT_PATH`, when the environment sets it.
 * @returns The variables to add to a workspace container's environment; empty when none apply.
 * @throws ConfigError when a script was named but cannot be read, is not a script, or would not
 *   fit in an environment variable.
 */
export function fakeProviderScriptEnv(
  provider: AppConfig['AGENT_MODEL_PROVIDER'],
  path: string | undefined,
): Record<string, string> {
  if (provider !== 'fake' || path === undefined) {
    return {};
  }
  const value = JSON.stringify(readFakeProviderScript(path));
  assertScriptFitsEnvironment(path, value);
  return { [FAKE_SCRIPT_ENV_KEY]: value };
}
