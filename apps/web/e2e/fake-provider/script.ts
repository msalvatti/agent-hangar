/**
 * Schema and loader for the scripted responses the fake model provider plays during a real-stack
 * run.
 *
 * Layer: test support (pure).
 *
 * The script is data rather than code because the provider that plays it runs inside the workspace
 * container, which the suite does not import. The worker is the join: it reads the file named by
 * `FAKE_PROVIDER_SCRIPT_PATH` at boot, validates it, and forwards its content to each container as
 * `AGENT_FAKE_SCRIPT_JSON`, which carries the script itself rather than a path. What this module
 * gives is the shape the file must have, pinned by tests on this side, so a script the worker
 * would refuse at boot — or whose tool calls the runtime would refuse mid-turn — fails here first.
 * The placeholder itself is substituted inside the container, where the credential already lives,
 * so nothing on this side fills it in.
 *
 * No credential-shaped literal is written into the file. The one step whose arguments must carry
 * a credential — so the suite can prove the worker redacts it before persisting — writes the
 * placeholder below instead, and the container fills it from the credential it already holds.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** Placeholder standing in for the GitHub canary inside the script file. */
export const GITHUB_CANARY_PLACEHOLDER = '{{GITHUB_CANARY}}';

/** Deepest directory tree `list_dir` will walk, as the runtime's schema bounds it. */
const MAX_LIST_DIR_DEPTH = 5;

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

/**
 * Mirror of the runtime's strict tool-argument schemas, so a script the tools would refuse fails
 * here and not as a tool call that dies in a millisecond.
 *
 * Providers are asked for strict function calling, which requires every property to be present:
 * an optional argument is expressed as a nullable one that is always sent, and the runtime
 * validates on exactly that basis. A scripted call that omits one is therefore rejected before the
 * tool runs, with no exit code and no output, which reads as a broken tool rather than a broken
 * script. The runtime is not a dependency of this app, so the shapes are restated here the way the
 * `ModelEvent` union above already is.
 */
const toolArguments: Record<string, z.ZodType> = {
  run_shell: z
    .object({
      command: z.string().min(1),
      cwd: z.string().nullable(),
      timeoutMs: z.number().int().positive().nullable(),
    })
    .strict(),
  read_file: z
    .object({
      path: z.string().min(1),
      startLine: z.number().int().positive().nullable(),
      endLine: z.number().int().positive().nullable(),
    })
    .strict(),
  write_file: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  list_dir: z
    .object({
      path: z.string().nullable(),
      depth: z.number().int().min(1).max(MAX_LIST_DIR_DEPTH).nullable(),
    })
    .strict(),
};

/**
 * Reports why a scripted tool call's arguments would not survive the runtime, if they would not.
 *
 * A name no tool answers to is left alone: a script is allowed to prove what an unknown tool does.
 *
 * @param name - Tool name as the script writes it.
 * @param args - The call's arguments, as the JSON text the script carries.
 * @returns The problem, or `null` when the arguments are acceptable.
 */
function describeArgumentProblem(name: string, args: string): string | null {
  const schema = toolArguments[name];
  if (schema === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return 'arguments are not valid JSON';
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return null;
  }
  // The property is named, not just the complaint: "expected number, received undefined" on its
  // own does not say which argument is missing, which is the only thing the reader needs.
  return result.error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('; ');
}

/** Steps keyed by the exact text of the last user message, plus a `default` key. */
const providerScript = z
  .record(z.string(), z.array(scriptedStep).min(1))
  .superRefine((script, ctx) => {
    for (const [prompt, steps] of Object.entries(script)) {
      for (const event of steps.flatMap((step) => step.events)) {
        if (event.type !== 'tool_call') {
          continue;
        }
        const problem = describeArgumentProblem(event.name, event.arguments);
        if (problem !== null) {
          ctx.addIssue({
            code: 'custom',
            message: `${prompt} / ${event.callId} (${event.name}): ${problem}`,
          });
        }
      }
    }
  });

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
