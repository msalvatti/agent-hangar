/**
 * A scripted stand-in for the agent runtime, for use with `FakeWorkspaceRunner`.
 *
 * Layer: test double.
 *
 * The processors are exercised against the NDJSON stream the real runtime would produce, byte for
 * byte, without Docker: the script encodes the events the container would write on stdout and
 * ends with the exit the runner would report. Splitting the stream at arbitrary byte offsets is
 * the point of `splitChunks` — a chunk boundary in the middle of a line, or in the middle of a
 * multi-byte character, is what a real exec stream does and what the parser must survive.
 */
import { encodeLine } from '@agent-hangar/core';
import type { AgentEvent, ExecEvent, ExecSpec } from '@agent-hangar/core';
import type { ExecScript } from '@agent-hangar/core/testing';

/** Bytes per stdout chunk when the script is asked to split the stream. */
export const SPLIT_CHUNK_BYTES = 9;

/** The command the worker execs; the script answers only to it. */
const RUNTIME_COMMAND_HEAD = 'node';

/** Last argument of the runtime command. */
const RUNTIME_COMMAND_TAIL = 'turn';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** How a scripted runtime behaves beyond emitting its events. */
export interface ScriptedRuntimeOptions {
  /** Exit code of the fake process; defaults to 0. */
  exitCode?: number;
  /** Splits stdout into {@link SPLIT_CHUNK_BYTES} chunks, ignoring line boundaries. */
  splitChunks?: boolean;
  /** Lines written to stderr before the events, as the real runtime writes diagnostics. */
  stderr?: readonly string[];
  /**
   * Emits the first `afterEvent` events and then waits to be cancelled instead of exiting.
   *
   * `FakeWorkspaceRunner.signal` aborts the exec, so the stream then ends with
   * `exit { code: null, signal }` and no terminal event — exactly what a runtime that ignores
   * SIGINT produces, and the case the executor's cancellation handling has to classify.
   */
  holdUntilSignal?: { afterEvent: number };
}

/**
 * Resolves when an abort signal fires.
 *
 * @param signal - Signal of the in-flight exec.
 * @returns A promise that settles on abort.
 */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    });
  });
}

/**
 * Splits encoded output into the chunks the script emits.
 *
 * @param text - The whole stdout text.
 * @param split - Whether to cut it into fixed-size chunks.
 * @returns One chunk per stdout event.
 */
function chunksOf(text: string, split: boolean): Uint8Array[] {
  const bytes = encoder.encode(text);
  if (!split) {
    return bytes.length === 0 ? [] : [bytes];
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += SPLIT_CHUNK_BYTES) {
    chunks.push(bytes.slice(offset, offset + SPLIT_CHUNK_BYTES));
  }
  return chunks;
}

/**
 * Builds an exec script that replays agent events as the runtime would.
 *
 * @param events - Events to write on stdout, in order.
 * @param options - Exit code, chunking, stderr noise and the cancellation hold.
 * @returns A script `FakeWorkspaceRunner` matches against the runtime command.
 */
export function scriptedRuntime(
  events: readonly AgentEvent[],
  options: ScriptedRuntimeOptions = {},
): ExecScript {
  const hold = options.holdUntilSignal;
  const emitted = hold === undefined ? events : events.slice(0, hold.afterEvent);
  const text = emitted.map((event) => encodeLine(event)).join('');

  return {
    match: (cmd) => cmd[0] === RUNTIME_COMMAND_HEAD && cmd.at(-1) === RUNTIME_COMMAND_TAIL,
    events: async function* script(_spec: ExecSpec, signal: AbortSignal): AsyncIterable<ExecEvent> {
      for (const line of options.stderr ?? []) {
        yield { type: 'stderr', data: encoder.encode(`${line}\n`) };
      }
      for (const chunk of chunksOf(text, options.splitChunks === true)) {
        yield { type: 'stdout', data: chunk };
      }
      if (hold !== undefined) {
        await whenAborted(signal);
        return;
      }
      yield { type: 'exit', code: options.exitCode ?? 0 };
    },
  };
}

/**
 * Reads back what the worker wrote to a runtime's stdin.
 *
 * @param spec - The exec spec `FakeWorkspaceRunner` recorded.
 * @returns The stdin text, empty when nothing was written.
 */
export async function stdinOf(spec: ExecSpec): Promise<string> {
  const { stdin } = spec;
  if (stdin === undefined) {
    return '';
  }
  if (typeof stdin === 'string') {
    return stdin;
  }
  if (stdin instanceof Uint8Array) {
    return decoder.decode(stdin);
  }
  let text = '';
  for await (const chunk of stdin) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
