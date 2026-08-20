/**
 * The real-model smoke check: one turn, driven end to end, and the assertions that decide whether
 * it proved anything.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * Every automated suite in this repository runs against a scripted provider, which is right for
 * continuous integration and leaves the real provider unexercised. The one time that path broke it
 * broke silently: the provider was never wired into the binary the container runs, so every real
 * turn failed at composition while every test stayed green. This check answers "does a real turn
 * still work?" in one command, and it answers it by making a turn do both halves of what the
 * product claims — read the repository and write a file in it — then asserting on the tool calls
 * that ran and the exit codes they returned. It is an operator tool: it is never part of CI.
 *
 * Output is written on the assumption that it will be pasted somewhere public. It carries names,
 * counts, statuses, exit codes and git object names, plus bounded slices of text the server has
 * already redacted twice; request bodies are never echoed, and the base URL never appears at all.
 *
 * The order of the last three steps is deliberate: the stream is read to its end, the workspace is
 * released, and only then is the verdict decided. A check that creates a container has to give it
 * back whatever it concluded, so nothing between the turn and the cleanup is allowed to throw.
 */
import { buildPath, routes } from '../../../packages/core/src/api/contracts.js';

import {
  cleanupChat,
  createChat,
  errorName,
  preflight,
  SmokeAbort,
} from './smoke-openai-client.js';
import type { SmokeDeps } from './smoke-openai-client.js';
import {
  createEventRecorder,
  createFrameDecoder,
  FINAL_MESSAGE_PREVIEW_LENGTH,
  formatTokens,
} from './smoke-openai-events.js';
import type {
  EventRecorder,
  FrameDecoder,
  SmokeObservation,
  ToolCallRecord,
} from './smoke-openai-events.js';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PRECONDITION,
  MS_PER_SECOND,
  SMOKE_FILE,
} from './smoke-openai-options.js';
import type { SmokeOptions } from './smoke-openai-options.js';

/** What {@link runSmoke} tells its caller. */
export interface SmokeResult {
  /** Process exit code: {@link EXIT_OK}, {@link EXIT_FAILED} or {@link EXIT_PRECONDITION}. */
  exitCode: number;
  /** The summary line, or the empty string when the check stopped before producing one. */
  summary: string;
}

/** What the stream produced, and why it stopped early when it did. */
interface TurnOutcome {
  /** Everything the events said. */
  observation: SmokeObservation;
  /** Why the stream ended without a terminal event, or `null` when it did not. */
  interruption: string | null;
}

/** What one chunk did to the read loop. */
type ChunkOutcome =
  /** Nothing terminal in it; keep reading. */
  | { stop: false }
  /** Stop, with the reason the transcript cannot be trusted, or `null` when the turn ended. */
  | { stop: true; interruption: string | null };

/**
 * Feeds one chunk of the stream to the recorder, printing what it produces.
 *
 * @param text - Decoded chunk.
 * @param decoder - Frame decoder holding the remainder of the previous chunk.
 * @param recorder - Recorder for this turn.
 * @param deps - Injected collaborators.
 * @returns Whether the loop should stop, and why when the reason is not simply "the turn ended".
 */
function consumeChunk(
  text: string,
  decoder: FrameDecoder,
  recorder: EventRecorder,
  deps: SmokeDeps,
): ChunkOutcome {
  for (const frame of decoder.push(text)) {
    if (frame.kind === 'expired') {
      return {
        stop: true,
        interruption: 'the replay cache expired, so the transcript cannot be verified',
      };
    }
    if (frame.kind === 'undecodable') {
      deps.log(`unreadable frame event=${frame.name}`);
      continue;
    }
    const line = recorder.record(frame.event);
    if (line !== null) {
      deps.log(line);
    }
    if (recorder.observation.terminal !== null) {
      return { stop: true, interruption: null };
    }
  }
  return { stop: false };
}

/**
 * Reads the event stream to its terminal event, its timeout, or its end.
 *
 * The timeout cancels the reader rather than racing it. A race leaves the losing promise pending
 * and able to reject after the winner returned, which is an unhandled rejection in the ordinary
 * timeout case; cancelling makes the pending read resolve as `done` and keeps one chain.
 *
 * @param body - Response body.
 * @param recorder - Recorder the events are accumulated into; owned by the caller, so what was
 * seen survives however this returns.
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @returns Why the stream stopped early, or `null` when the turn reached a terminal event.
 * @throws when releasing the connection fails; the caller keeps the observation regardless.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  recorder: EventRecorder,
  options: SmokeOptions,
  deps: SmokeDeps,
): Promise<string | null> {
  const decoder = createFrameDecoder();
  const text = new TextDecoder();
  const reader = body.getReader();
  let interruption: string | null = 'the stream ended before the turn reached a terminal event';
  let clean = false;
  // The deadline is an `AbortSignal` rather than a boolean because control-flow analysis does not
  // model a timer callback: a local `let` set only in one keeps the value its initialiser gave it
  // as far as the checker is concerned, which turns the test after the loop into dead code. A
  // signal carries the same one bit and is read through an object the checker cannot narrow.
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
    void reader.cancel();
  }, options.timeoutMs);
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const outcome = consumeChunk(
        text.decode(chunk.value, { stream: true }),
        decoder,
        recorder,
        deps,
      );
      if (outcome.stop) {
        interruption = outcome.interruption;
        clean = true;
        break;
      }
      chunk = await reader.read();
    }
  } catch (error) {
    interruption = `the event stream dropped (${errorName(error)})`;
  } finally {
    clearTimeout(timer);
    if (clean) {
      await reader.cancel();
    }
  }
  if (deadline.signal.aborted) {
    return `timed out after ${options.timeoutMs / MS_PER_SECOND} s — is the worker running?`;
  }
  return interruption;
}

/**
 * Subscribes to the chat's turn events and reads them to the end.
 *
 * Never throws: the chat exists by the time this runs, and its workspace has to be released
 * whatever happens here, so every failure comes back as an interruption instead.
 *
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @param chatId - Chat whose latest turn is streamed.
 * @returns What was observed, and why the stream stopped when it stopped early.
 */
async function observeTurn(
  options: SmokeOptions,
  deps: SmokeDeps,
  chatId: string,
): Promise<TurnOutcome> {
  const path = buildPath(routes.chatEvents, { id: chatId });
  const recorder = createEventRecorder();
  const observation = recorder.observation;
  let response: Response;
  try {
    response = await deps.fetch(`${options.baseUrl}${path}`, {
      headers: { accept: 'text/event-stream' },
    });
  } catch (error) {
    return { observation, interruption: `could not open ${path} (${errorName(error)})` };
  }
  if (!response.ok) {
    return { observation, interruption: `${path} answered HTTP ${response.status}` };
  }
  if (response.body === null) {
    return { observation, interruption: `${path} answered with no body` };
  }
  try {
    return { observation, interruption: await readStream(response.body, recorder, options, deps) };
  } catch (error) {
    // Only releasing the connection can reach here, and the turn's outcome is already recorded.
    // Reporting it as an interruption keeps this function's promise never to throw, which is what
    // the workspace cleanup after it depends on.
    return {
      observation,
      interruption: `the event stream could not be closed (${errorName(error)})`,
    };
  }
}

/**
 * Programs that enumerate a directory tree, for the `run_shell` form of the listing step.
 *
 * The model is asked to list the repository's files and is free to choose how. Measured against
 * `gpt-5.6-sol`, it reaches for `find` as readily as for `list_dir`, so accepting only the tool
 * would make the check report a defect every time the model picked the other perfectly good way.
 * `git ls-files` is matched as a pair, since `git` on its own lists nothing.
 */
const LISTING_PROGRAMS: readonly string[] = ['ls', 'find', 'tree'];

/**
 * Splits a shell command into bare words, dropping quoting, redirections and separators.
 *
 * @param command - The command the model asked to run.
 * @returns Its words, in order.
 */
function commandWords(command: string): string[] {
  return command.split(/[^A-Za-z0-9_.-]+/).filter((word) => word !== '');
}

/**
 * Whether a shell command runs one of {@link LISTING_PROGRAMS}.
 *
 * A word match, so a listing program named as an argument to something else counts too. That is
 * the loose direction on purpose: this decides whether the turn read the repository at all, and
 * the assertion that has to be exact is the one about the file it wrote.
 *
 * @param command - The command the model asked to run.
 * @returns `true` when a listing program appears among its words.
 */
function runsListingCommand(command: string): boolean {
  const words = commandWords(command);
  return words.some(
    (word, index) =>
      LISTING_PROGRAMS.includes(word) || (word === 'git' && words[index + 1] === 'ls-files'),
  );
}

/**
 * Whether a tool call listed the repository's files.
 *
 * @param call - One recorded call.
 * @returns `true` for a successful `list_dir`, or a successful `run_shell` that ran a listing
 * program.
 */
function isListing(call: ToolCallRecord): boolean {
  if (call.status !== 'SUCCEEDED') {
    return false;
  }
  return call.name === 'list_dir' || (call.name === 'run_shell' && runsListingCommand(call.target));
}

/**
 * Whether a tool call wrote {@link SMOKE_FILE}.
 *
 * @param call - One recorded call.
 * @returns `true` for a successful `write_file` whose path ends in the expected name.
 */
function isSmokeWrite(call: ToolCallRecord): boolean {
  return (
    call.name === 'write_file' &&
    call.status === 'SUCCEEDED' &&
    (call.target === SMOKE_FILE || call.target.endsWith(`/${SMOKE_FILE}`))
  );
}

/**
 * States everything the turn failed to prove.
 *
 * @param outcome - What the stream produced.
 * @returns One entry per unmet requirement; empty when the check passed.
 */
function verify(outcome: TurnOutcome): string[] {
  const problems: string[] = [];
  if (outcome.interruption !== null) {
    problems.push(outcome.interruption);
  }
  if (outcome.observation.terminal === 'failed') {
    problems.push(`the turn failed — ${outcome.observation.failure}`);
  } else if (outcome.observation.terminal !== 'completed' && outcome.interruption === null) {
    problems.push('the turn did not complete');
  }
  if (!outcome.observation.toolCalls.some(isListing)) {
    problems.push('no successful tool call listed the repository');
  }
  if (!outcome.observation.toolCalls.some(isSmokeWrite)) {
    problems.push(`no successful write_file produced ${SMOKE_FILE}`);
  }
  return problems;
}

/**
 * Builds the one line that carries the evidence.
 *
 * @param model - Model id the instance reported.
 * @param observation - What the stream produced.
 * @param durationMs - Wall time of the whole check.
 * @returns The summary line.
 */
function formatSummary(model: string, observation: SmokeObservation, durationMs: number): string {
  const names = observation.toolCalls.map((call) => call.name).join(',');
  const duration = (durationMs / MS_PER_SECOND).toFixed(1);
  const pushed = observation.pushed === null ? '' : ` pushed=${observation.pushed.branch}`;
  return (
    `model=${model} steps=${observation.steps} toolCalls=${names === '' ? 'none' : names} ` +
    `duration=${duration}s tokens=${formatTokens(observation.usage)} ` +
    `assistantChars=${observation.assistantChars}${pushed}`
  );
}

/**
 * Runs the whole check, printing its report as it goes.
 *
 * @param options - Resolved command line.
 * @param deps - Injected collaborators.
 * @returns The exit code and the summary line.
 */
export async function runSmoke(options: SmokeOptions, deps: SmokeDeps): Promise<SmokeResult> {
  const startedAt = deps.now();
  try {
    const model = await preflight(options, deps);
    deps.log(`repo ${options.repoUrl} branch=${options.branch}`);
    const chat = await createChat(options, deps);
    deps.log(`chat=${chat.chatId} turn=${chat.turnId}`);

    const outcome = await observeTurn(options, deps, chat.chatId);
    const cleanup = await cleanupChat(options, deps, chat, outcome.observation.terminal === null);
    deps.log(cleanup.line);
    if (outcome.observation.finalMessage !== '') {
      const preview = outcome.observation.finalMessage
        .replace(/\s+/g, ' ')
        .slice(0, FINAL_MESSAGE_PREVIEW_LENGTH);
      deps.log(`final ${preview}`);
    }

    const summary = formatSummary(model, outcome.observation, deps.now() - startedAt);
    deps.log(summary);
    const problems = verify(outcome);
    if (!cleanup.settled) {
      problems.push('the chat was not deleted, so its workspace may still be running');
    }
    for (const problem of problems) {
      deps.log(`problem ${problem}`);
    }
    deps.log(problems.length === 0 ? 'smoke PASS' : 'smoke FAIL');
    return { exitCode: problems.length === 0 ? EXIT_OK : EXIT_FAILED, summary };
  } catch (error) {
    if (error instanceof SmokeAbort) {
      deps.log(`error ${error.message}`);
      // A precondition that does not hold is not a failed smoke: nothing was run, so reporting it
      // as a failure would put the blame on the product rather than on the instance's state.
      deps.log(error.exitCode === EXIT_PRECONDITION ? 'smoke NOT RUN' : 'smoke FAIL');
      return { exitCode: error.exitCode, summary: '' };
    }
    deps.log(`error unexpected failure (${errorName(error)})`);
    deps.log('smoke FAIL');
    return { exitCode: EXIT_FAILED, summary: '' };
  }
}
