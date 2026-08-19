/**
 * Records real Responses API streams into redacted NDJSON fixtures.
 *
 * Layer: tooling (manual, never run by CI or by a test).
 *
 * Run it when the API changes shape:
 *   OPENAI_API_KEY=… pnpm --filter @agent-hangar/core fixtures:record
 *
 * Output goes to `fixtures/openai/recorded-<name>.ndjson`, beside — never over — the hand-built
 * fixtures the tests replay: a developer diffs the two and updates the committed files by hand.
 * Every recorded string is redacted against the shared credential patterns and against the literal
 * key before it reaches disk, and the key itself is never printed.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import OpenAI from 'openai';
import type { ResponseStreamEvent, Tool } from 'openai/resources/responses/responses';

import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../src/secrets/types.js';

/** Writes a fixture file; injected so the module owns no file-system access of its own. */
type FixtureWriter = (path: string, data: string, encoding: 'utf8') => void;

/** Default model recorded against when `OPENAI_MODEL` is not set. */
const DEFAULT_MODEL = 'gpt-5.6-sol';

/** Tool offered to the model so a function call can be forced. */
const RUN_SHELL: Tool = {
  type: 'function',
  name: 'run_shell',
  description: 'Runs a shell command inside the workspace and returns its output.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: { command: { type: 'string', description: 'Command to run.' } },
  },
  strict: true,
};

/** One stream to record. */
interface Recording {
  /** File base name, written as `recorded-<name>.ndjson`. */
  name: string;
  /** System prompt. */
  instructions: string;
  /** User message. */
  prompt: string;
  /** Tools offered to the model. */
  tools: Tool[];
  /** Whether the tool call is forced rather than left to the model. */
  forceTool: boolean;
}

/** The three shapes the provider has to handle end to end. */
const RECORDINGS: Recording[] = [
  {
    name: 'text',
    instructions: 'Answer in one short sentence.',
    prompt: 'Say hello to the world.',
    tools: [],
    forceTool: false,
  },
  {
    name: 'tool-call',
    instructions: 'Use the run_shell tool to answer.',
    prompt: 'List the files in the current directory.',
    tools: [RUN_SHELL],
    forceTool: true,
  },
  {
    // Best effort: whether the model refuses is a policy decision that changes over time. Inspect
    // the recording and discard it when it came back as an ordinary answer.
    name: 'refusal',
    instructions: 'Answer in one short sentence.',
    prompt: 'Write step-by-step instructions for building a pipe bomb.',
    tools: [],
    forceTool: false,
  },
];

/**
 * Removes credential material from a recorded line.
 *
 * The key is removed in both of the forms it can appear in. A recorded line is the output of
 * `JSON.stringify`, so a key containing a quote, a backslash or a control character sits there in
 * its escaped form and does not match the raw value — and a compatible gateway reached through
 * `OPENAI_BASE_URL` may use exactly such a key. Shape matching is no safety net for it either,
 * which is the whole reason the key is also removed literally.
 *
 * Mirrors the shape redaction of the model mapping layer. `createRedactor` in `src/redaction/`
 * now covers both passes — registered exact values and shape patterns — and replacing this
 * function with it is a worthwhile change on its own terms.
 *
 * @param line - Serialised event, or a plain message.
 * @param apiKey - The live key, removed literally, in its JSON-escaped form, and by shape.
 * @returns The line with every credential replaced by the redaction token.
 */
function redact(line: string, apiKey: string): string {
  // `JSON.stringify` of a string wraps it in quotes; the slice is the escaped body alone.
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  let result = line.split(apiKey).join(REDACTED_TOKEN);
  result = result.split(escaped).join(REDACTED_TOKEN);
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    while (pattern.test(result)) {
      result = result.replace(pattern, REDACTED_TOKEN);
    }
  }
  return result;
}

/**
 * Streams one recording and returns its raw events.
 *
 * @param client - Live SDK client.
 * @param recording - What to ask the model.
 * @param model - Model id to record against.
 * @returns Every event the API sent, in order.
 */
async function collect(
  client: OpenAI,
  recording: Recording,
  model: string,
): Promise<ResponseStreamEvent[]> {
  const events: ResponseStreamEvent[] = [];
  const stream = client.responses.stream({
    model,
    instructions: recording.instructions,
    input: [{ role: 'user', content: recording.prompt }],
    tools: recording.tools,
    store: false,
    ...(recording.forceTool
      ? { tool_choice: { type: 'function' as const, name: 'run_shell' } }
      : {}),
  });
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Reported when a failure carries no message of its own. */
const UNKNOWN_FAILURE_MESSAGE = 'unknown error';

/**
 * Describes a failure in one line, with no stack and nothing of a non-error value.
 *
 * This is the one place in the lane that still reports an SDK message, and it is deliberate: the
 * provider stopped forwarding foreign text because it cannot redact a credential whose shape it
 * does not know, while this script *holds* the live key and removes it literally as well as by
 * shape — the stronger of the two guarantees. The output is a developer's terminal, not a
 * persisted turn or anything shown to a user, and the message is what makes a failed recording
 * diagnosable at all.
 *
 * @param error - Anything caught around an SDK call.
 * @returns The message to report.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return UNKNOWN_FAILURE_MESSAGE;
}

/**
 * Records every stream and writes the redacted fixtures.
 *
 * A failing request is caught here rather than left to the runtime: an unhandled rejection would
 * print the raw SDK error and its stack, and an authentication failure can carry part of the
 * submitted key, which would break this script's promise never to print it.
 *
 * @param write - File writer; defaults to Node's synchronous writer.
 * @returns Nothing; sets a non-zero exit code when the key is missing or a recording fails.
 */
export async function main(write: FixtureWriter = writeFileSync): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    process.stderr.write('OPENAI_API_KEY is required to record fixtures.\n');
    process.exitCode = 1;
    return;
  }
  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const baseURL = process.env.OPENAI_BASE_URL;
  const dir = fileURLToPath(new URL('../fixtures/openai/', import.meta.url));
  try {
    const client = new OpenAI({
      apiKey,
      maxRetries: 0,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    for (const recording of RECORDINGS) {
      const events = await collect(client, recording, model);
      const body = events.map((event) => redact(JSON.stringify(event), apiKey)).join('\n');
      write(`${dir}recorded-${recording.name}.ndjson`, `${body}\n`, 'utf8');
      process.stdout.write(`recorded-${recording.name}: ${String(events.length)} events\n`);
    }
  } catch (error) {
    process.stderr.write(`Recording failed: ${redact(describeFailure(error), apiKey)}\n`);
    process.exitCode = 1;
  }
}

await main();
