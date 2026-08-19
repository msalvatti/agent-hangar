/**
 * `run_shell`: runs one command in the workspace under a timeout, a byte budget and cancellation.
 *
 * Layer: domain.
 *
 * The command comes from a model that has read untrusted repository content, so three guarantees
 * matter more than convenience. The child gets the scrubbed environment, never the runtime's own,
 * so the GitHub PAT and the OpenAI key are out of reach. It is started as its own process group
 * and killed as a group, so a command that backgrounds work cannot outlive its timeout. And its
 * output is capped, so neither the model's context nor the event stream can be flooded.
 */
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { nodeSpawn } from '../spawn.js';
import type { SpawnedProcess, SpawnFunction } from '../spawn.js';

import { displayPath, PathEscapeError, resolveInsideWorkspace } from './paths.js';
import { failure, sliceToBytes, truncateOutput } from './result.js';
import type { ToolResult } from './result.js';
import type { RunShellArgs } from './schemas.js';

/** Grace period between the polite and the forceful kill after a cancellation, in ms. */
const ABORT_GRACE_MS = 2000;

/** Everything `run_shell` needs from the turn. */
export interface RunShellContext {
  /** Absolute workspace root; commands run here unless `cwd` says otherwise. */
  workspaceRoot: string;
  /** Child environment, already scrubbed of the credentials. */
  env: Record<string, string>;
  /** Timeout applied when the call does not name one. */
  defaultTimeoutMs: number;
  /** Byte budget for the result and for the streamed output. */
  maxOutputBytes: number;
  /** Process spawner; injectable so failures to start can be exercised. */
  spawn?: SpawnFunction;
}

/** Per-call hooks. */
export interface RunShellHooks {
  /**
   * Called with each piece of output as it arrives, until the byte budget is used up.
   *
   * @param stream - Which of the child's streams produced the text.
   * @param text - The piece of output.
   */
  onOutput?(stream: 'stdout' | 'stderr', text: string): void;
  /** Aborting terminates the command's process group. */
  signal?: AbortSignal;
}

/** Result of `run_shell`; carries the command so a push can be detected afterwards. */
export interface RunShellResult extends ToolResult {
  /** The command as the model wrote it. */
  command: string;
}

/** Mutable state of one run. */
interface RunState {
  /** Output kept for the result; capped, so a runaway command cannot fill the heap. */
  parts: string[];
  /** Bytes kept so far. */
  keptBytes: number;
  /** Bytes the command produced in total, including everything that was dropped. */
  totalBytes: number;
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * Signals a whole process group, ignoring a group that has already gone.
 *
 * @param pid - Group leader's pid, absent when the child never started.
 * @param signal - Signal to deliver.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group exited between the decision to kill it and the call; nothing left to do.
  }
}

/**
 * Streams one of the child's outputs into the shared buffer, in arrival order.
 *
 * @param source - The child's stdout or stderr.
 * @param name - Which stream this is, for the hook.
 * @param state - Run state, mutated in place.
 * @param hooks - Per-call hooks.
 * @param maxOutputBytes - Budget after which output is counted but neither kept nor streamed.
 */
function collectStream(
  source: Readable | null,
  name: 'stdout' | 'stderr',
  state: RunState,
  hooks: RunShellHooks,
  maxOutputBytes: number,
): void {
  if (source === null) {
    return;
  }
  // Setting the encoding lets the stream carry a multi-byte character across a chunk boundary.
  source.setEncoding('utf8');
  source.on('data', (chunk: string) => {
    state.totalBytes += Buffer.byteLength(chunk);
    // Past the budget the output is counted and thrown away. A command the model wrote can emit
    // gigabytes in seconds, and buffering all of it would exhaust the container long before the
    // per-command timeout could stop it.
    const remaining = maxOutputBytes - state.keptBytes;
    if (remaining <= 0) {
      return;
    }
    // The chunk is cut to what is left rather than kept whole: a pipe hands over tens of kilobytes
    // at a time, so keeping the chunk that crosses the line would overshoot the budget by all of
    // it — which is what the budget exists to prevent on the streamed events as much as here.
    const piece = sliceToBytes(chunk, remaining);
    state.parts.push(piece);
    state.keptBytes += Buffer.byteLength(piece);
    hooks.onOutput?.(name, piece);
  });
}

/**
 * Turns the collected output and the exit status into a tool result.
 *
 * @param args - The call's arguments.
 * @param maxOutputBytes - Byte budget for the result.
 * @param state - Run state after the child closed.
 * @param code - Exit code, `null` when the child was killed by a signal.
 * @returns The result handed back to the loop.
 */
function buildResult(
  args: RunShellArgs,
  maxOutputBytes: number,
  state: RunState,
  code: number | null,
): RunShellResult {
  const joined = state.parts.join('');
  const collected = state.cancelled ? `${joined}\n[cancelled]` : joined;
  const { text, bytes } = truncateOutput(collected, maxOutputBytes, state.totalBytes);
  const completed = code === 0 ? 'SUCCEEDED' : 'FAILED';
  return {
    output: text,
    bytes,
    exitCode: code,
    status: state.timedOut ? 'TIMED_OUT' : state.cancelled ? 'FAILED' : completed,
    command: args.command,
  };
}

/**
 * Resolves the directory the command runs in.
 *
 * @param args - The call's arguments.
 * @param context - Run context.
 * @returns The absolute directory, or a failed result explaining why it cannot be used.
 */
async function resolveWorkingDirectory(
  args: RunShellArgs,
  context: RunShellContext,
): Promise<string | ToolResult> {
  if (args.cwd === null) {
    return context.workspaceRoot;
  }
  try {
    const resolved = await resolveInsideWorkspace(context.workspaceRoot, args.cwd);
    const entry = await stat(resolved);
    return entry.isDirectory()
      ? resolved
      : failure(`cwd is not a directory: ${displayPath(context.workspaceRoot, resolved)}`);
  } catch (error) {
    return error instanceof PathEscapeError
      ? failure(error.message)
      : failure(`cwd does not exist: ${args.cwd}`);
  }
}

/**
 * Arms the timeout and the cancellation for a running command.
 *
 * @param child - The running child.
 * @param state - Run state, marked when either fires.
 * @param timeoutMs - How long the command may run.
 * @param signal - Cancellation, when the caller supplied one.
 * @returns A teardown that clears the timers and unsubscribes the signal.
 */
function armTermination(
  child: SpawnedProcess,
  state: RunState,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): () => void {
  const timers = [
    setTimeout(() => {
      state.timedOut = true;
      killGroup(child.pid, 'SIGKILL');
    }, timeoutMs),
  ];
  const onAbort = (): void => {
    state.cancelled = true;
    killGroup(child.pid, 'SIGTERM');
    timers.push(
      setTimeout(() => {
        killGroup(child.pid, 'SIGKILL');
      }, ABORT_GRACE_MS),
    );
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // A listener added to an already-aborted signal is never called, so a cancellation that
  // arrived before the command started would otherwise let it run to completion.
  if (signal?.aborted === true) {
    onAbort();
  }
  return () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    signal?.removeEventListener('abort', onAbort);
  };
}

/**
 * Starts the command and resolves once it has closed, been killed or failed to start.
 *
 * @param args - The call's arguments.
 * @param context - Run context.
 * @param hooks - Per-call hooks.
 * @param cwd - Directory to run in.
 * @returns The result.
 */
function execute(
  args: RunShellArgs,
  context: RunShellContext,
  hooks: RunShellHooks,
  cwd: string,
): Promise<RunShellResult> {
  const spawnFn = context.spawn ?? nodeSpawn;
  const state: RunState = {
    parts: [],
    keptBytes: 0,
    totalBytes: 0,
    timedOut: false,
    cancelled: false,
  };

  return new Promise<RunShellResult>((resolve) => {
    const child = spawnFn('bash', ['-lc', args.command], {
      cwd,
      env: context.env,
      // Its own process group, so the timeout can take the command's children with it.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    collectStream(child.stdout, 'stdout', state, hooks, context.maxOutputBytes);
    collectStream(child.stderr, 'stderr', state, hooks, context.maxOutputBytes);
    const disarm = armTermination(
      child,
      state,
      args.timeoutMs ?? context.defaultTimeoutMs,
      hooks.signal,
    );
    child.on('error', (error: Error) => {
      disarm();
      resolve({ ...failure(`failed to start command: ${error.message}`), command: args.command });
    });
    child.on('close', (code: number | null) => {
      disarm();
      resolve(buildResult(args, context.maxOutputBytes, state, code));
    });
  });
}

/**
 * Runs a shell command inside the workspace.
 *
 * @param args - Validated arguments.
 * @param context - Run context.
 * @param hooks - Output streaming and cancellation.
 * @returns The result; never throws, so one bad command cannot end the turn.
 */
export async function runShell(
  args: RunShellArgs,
  context: RunShellContext,
  hooks: RunShellHooks = {},
): Promise<RunShellResult> {
  const cwd = await resolveWorkingDirectory(args, context);
  if (typeof cwd !== 'string') {
    return { ...cwd, command: args.command };
  }
  return execute(args, context, hooks, cwd);
}
