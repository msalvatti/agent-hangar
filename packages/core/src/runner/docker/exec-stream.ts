/**
 * Plumbing for a Docker exec: frame demultiplexing, the stdin pump and the termination path.
 *
 * Layer: service (adapter).
 *
 * Docker multiplexes stdout and stderr over one hijacked connection using an 8-byte frame header
 * (byte 0 = stream type, bytes 4–7 = big-endian payload length). Everything here works on plain
 * Node streams and injected timers, so the timeout and cancellation paths — the ones that are
 * hardest to observe against a real daemon — are exercised deterministically by unit tests.
 *
 * The command wrappers exist because dockerode's `exec.inspect().Pid` is a host pid and cannot be
 * signalled from inside the container: the wrapper records the shell's own pid in a tmpfs file that
 * a later `kill` exec reads back.
 */
import { ProtocolError } from '../../errors.ts';
import type { ExecEvent, ExecSignal, ExecSpec } from '../types.ts';

import { DockerRunnerError } from './errors.ts';

/** Bytes of the Docker stream frame header that precede every payload. */
const FRAME_HEADER_BYTES = 8;

/** Offset of the big-endian uint32 payload length inside the frame header. */
const FRAME_SIZE_OFFSET = 4;

/**
 * Directory (on the container's tmpfs `/tmp`) holding one pid file per exec.
 *
 * The workspace user can write here, so a hostile workspace could point a signal at a different
 * pid. That grants nothing: every process in the container already belongs to that same user and
 * PID namespace, so it could signal them directly. The file is a rendezvous point, not a
 * privilege boundary — the boundary is the container itself.
 */
export const EXEC_PID_DIR = '/tmp/ah-exec';

/**
 * Accepted shape of an exec reference.
 *
 * Deliberately narrow: the reference is interpolated into a `sh -c` argument list, so restricting
 * it to the hex-and-dash alphabet of a UUID removes every shell metacharacter, quote and space
 * that could break out of the wrapper script.
 */
const EXEC_REF_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * The only signal names that may be interpolated into the kill command.
 *
 * The parameter is already typed as {@link ExecSignal}, but the value originates in an HTTP request
 * body and this is where a string becomes part of a shell command — the one place where a type
 * that was not enforced at the boundary would turn into command injection.
 */
const ALLOWED_SIGNALS: readonly string[] = ['INT', 'TERM', 'KILL'];

/** UTF-8 encoder for string stdin. */
const encoder = new TextEncoder();

/** Reason an exec was ended by the runner rather than by the process exiting. */
export type ExecTermination = 'TIMEOUT' | 'ABORTED';

/**
 * Schedules `callback` after `ms` and returns a function that cancels it.
 *
 * The canceller is returned instead of a timer handle so the seam is a plain function on both
 * sides: production wires it to `setTimeout`/`clearTimeout`, and a test supplies a stub without
 * having to produce a value of the platform's opaque handle type.
 */
export type ScheduleTimeout = (callback: () => void, ms: number) => () => void;

/** The real scheduler, used when no override is given. */
export const systemScheduleTimeout: ScheduleTimeout = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => {
    clearTimeout(handle);
  };
};

/** Incremental parser for Docker's multiplexed attach/exec stream. */
export interface DockerDemuxer {
  /**
   * Feeds bytes in and returns every complete frame they produced.
   *
   * @param chunk - Bytes as they arrived; frames may span chunks in either direction.
   * @returns Zero or more output events, in stream order.
   * @throws ProtocolError when a frame declares an unknown stream type.
   */
  push(chunk: Uint8Array): ExecEvent[];
  /** Bytes buffered because they do not yet form a complete frame. */
  pendingBytes(): number;
}

/** The hijacked exec stream, as far as the pump is concerned. */
export interface ExecStream extends AsyncIterable<Uint8Array> {
  /** Ends the iteration early; the pump calls it after a timeout or an abort. */
  destroy(error?: Error): unknown;
}

/** Writable half of the hijacked exec stream. */
export interface ExecStdinStream {
  /**
   * Writes a chunk.
   *
   * @param chunk - Bytes to write.
   * @returns `false` when the internal buffer is full and `'drain'` must be awaited.
   */
  write(chunk: Uint8Array): boolean;
  /** Registers a one-shot listener, used to await `'drain'`. */
  once(event: 'drain', listener: () => void): unknown;
  /** Half-closes the stream so the process sees EOF on stdin. */
  end(): unknown;
}

/** Everything {@link pumpExecStream} needs to turn a hijacked stream into `ExecEvent`s. */
export interface PumpExecParams {
  /** The hijacked exec stream. */
  stream: ExecStream;
  /** Parser for the frames arriving on `stream`. */
  demuxer: DockerDemuxer;
  /** Wall-clock limit; omitted means no limit. */
  timeoutMs?: number | undefined;
  /** Cancellation signal; aborting ends the exec like a timeout does. */
  signal?: AbortSignal | undefined;
  /** Terminates the process inside the container. */
  kill: (reason: ExecTermination) => Promise<void>;
  /** Reads the process exit code once the stream closed on its own. */
  inspectExitCode: () => Promise<number | null>;
  /** Timer seam; injected by tests. */
  scheduleTimeout?: ScheduleTimeout | undefined;
}

/**
 * Maps a Docker frame's stream-type byte to the event it produces.
 *
 * @param type - Byte 0 of the frame header.
 * @returns The event kind (`stdout` for types 0 and 1, `stderr` for type 2).
 * @throws ProtocolError for any other value, which means the framing is out of sync.
 */
function streamKindFor(type: number): 'stdout' | 'stderr' {
  if (type === 0 || type === 1) {
    return 'stdout';
  }
  if (type === 2) {
    return 'stderr';
  }
  throw new ProtocolError(`unexpected docker stream type ${type}`);
}

/**
 * Creates a demultiplexer for Docker's multiplexed stream format.
 *
 * @returns A stateful parser; feed every chunk in arrival order.
 */
export function createDockerDemuxer(): DockerDemuxer {
  let buffered = Buffer.alloc(0);

  return {
    push(chunk: Uint8Array): ExecEvent[] {
      buffered = Buffer.concat([buffered, chunk]);
      const events: ExecEvent[] = [];

      while (buffered.length >= FRAME_HEADER_BYTES) {
        const kind = streamKindFor(buffered.readUInt8(0));
        const size = buffered.readUInt32BE(FRAME_SIZE_OFFSET);
        const frameEnd = FRAME_HEADER_BYTES + size;
        if (buffered.length < frameEnd) {
          break;
        }

        // A zero-length frame carries no output; Docker emits them and an empty `stdout` event
        // would be indistinguishable from real output of length zero downstream.
        if (size > 0) {
          // Copy the payload: `buffered` is re-sliced below, and a view would keep the consumer
          // holding memory the parser still owns.
          const data = new Uint8Array(buffered.subarray(FRAME_HEADER_BYTES, frameEnd));
          events.push({ type: kind, data });
        }
        buffered = buffered.subarray(frameEnd);
      }

      return events;
    },
    pendingBytes(): number {
      return buffered.length;
    },
  };
}

/**
 * Writes one chunk, awaiting `'drain'` when the stream signals backpressure.
 *
 * The wait is bounded by `signal`, because `'drain'` is not guaranteed to arrive: a timeout or an
 * abort destroys the hijacked stream, and a stream destroyed while its buffer is full never emits
 * the event. Without the race this promise would never settle, the awaited stdin writer would stay
 * pending, and no terminal event would reach the caller — the same hang the iterator race prevents
 * on the other side of the pump. Every path that destroys the stream aborts this signal too.
 *
 * @param stream - Writable half of the exec stream.
 * @param chunk - Bytes to write.
 * @param signal - Cancellation; aborting abandons a wait for backpressure to clear.
 * @returns A promise that resolves once the chunk has been accepted, or the write was abandoned.
 */
async function writeChunk(
  stream: ExecStdinStream,
  chunk: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  if (stream.write(chunk)) {
    return;
  }
  const drained = new Promise<void>((resolve) => {
    stream.once('drain', resolve);
  });
  await raceAbort(drained, signal);
}

/** Accepted stdin payloads, mirroring the `ExecSpec` contract. */
export type ExecStdin = ExecSpec['stdin'];

/**
 * Writes the exec's stdin and always closes it.
 *
 * Closing is unconditional and happens even when nothing was written: a process reading stdin (the
 * agent runtime reads an NDJSON turn request from it) hangs forever without EOF, and that hang
 * would only surface as a turn timeout minutes later.
 *
 * @param stream - Writable half of the hijacked exec stream.
 * @param stdin - String, byte array, async iterable of byte arrays, or nothing.
 * @param signal - Optional cancellation; aborting stops an in-flight async iterable.
 * @returns A promise that resolves once stdin has been written and closed.
 */
export async function writeStdin(
  stream: ExecStdinStream,
  stdin: ExecStdin,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (typeof stdin === 'string') {
      await writeChunk(stream, encoder.encode(stdin), signal);
      return;
    }
    if (stdin instanceof Uint8Array) {
      await writeChunk(stream, stdin, signal);
      return;
    }
    if (stdin === undefined) {
      return;
    }
    await drainIterable(stream, stdin, signal);
  } finally {
    stream.end();
  }
}

/**
 * Writes an async iterable to stdin, abandoning it the moment `signal` aborts.
 *
 * Checking `signal.aborted` between chunks is not enough: a source whose `next()` never settles
 * leaves the await pending for good, and the caller — which awaits this writer before the exec is
 * considered over — would then never see a terminal event, defeating both the timeout and the
 * abort. The pending `next()` is therefore raced against the abort, and the iterator is closed on
 * the way out so the source can release whatever it was holding.
 *
 * @param stream - Writable half of the hijacked exec stream.
 * @param stdin - Source of chunks.
 * @param signal - Cancellation; aborting abandons an in-flight `next()`.
 */
async function drainIterable(
  stream: ExecStdinStream,
  stdin: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const iterator = stdin[Symbol.asyncIterator]();
  try {
    while (signal?.aborted !== true) {
      const next = await raceAbort(iterator.next(), signal);
      if (next === ABORTED || next.done === true) {
        return;
      }
      await writeChunk(stream, next.value, signal);
    }
  } finally {
    await Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/** Sentinel returned by {@link raceAbort} when the signal won the race. */
const ABORTED = Symbol('aborted');

/**
 * Resolves with the promise's value, or with {@link ABORTED} as soon as `signal` aborts.
 *
 * @param promise - Work that may never settle on its own.
 * @param signal - Cancellation; omitted means simply awaiting the promise.
 * @returns The settled value, or `ABORTED`.
 */
async function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal === undefined) {
    return promise;
  }
  // The rejection is marked handled so abandoning the source never surfaces as an unhandled
  // rejection; the value is simply dropped once the abort has won.
  promise.catch(() => undefined);
  // Checked before the listener is registered: the source itself may abort while producing the
  // value this call is racing, and `addEventListener` on an already-aborted signal never fires —
  // which would silently hand back the very chunk the abort was meant to discard.
  if (signal.aborted) {
    return ABORTED;
  }
  // Definitely assigned: the Promise executor runs synchronously during construction, so `onAbort`
  // holds the resolver before the next statement reads it.
  let onAbort!: () => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => {
      resolve(ABORTED);
    };
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Watches the two conditions that end an exec early, and remembers which one fired. */
interface TerminationWatch {
  /** Why the runner ended the exec, or `null` while the process is running on its own terms. */
  reason(): ExecTermination | null;
  /**
   * Settles when the termination attempt has finished; rejects if the process could not be killed.
   *
   * Resolves immediately when nothing terminated the exec.
   */
  killed(): Promise<void>;
  /** Cancels the timer and removes the abort listener. */
  dispose(): void;
}

/**
 * Arms the timeout and the abort listener that can end an exec.
 *
 * Termination is idempotent: the first of the two to fire wins. A second one must not kill again,
 * because by then the pid file may name a different process — the next exec reusing the slot.
 *
 * @param params - The pump's parameters; supplies the stream, the signal, the kill and the limit.
 * @param schedule - Timer seam used for the wall-clock limit.
 * @returns A watch reporting the termination reason and releasing both resources on `dispose`.
 */
function watchTermination(params: PumpExecParams, schedule: ScheduleTimeout): TerminationWatch {
  const { stream, signal, kill } = params;
  let terminated: ExecTermination | null = null;
  let cancelTimeout: (() => void) | undefined;
  let killed: Promise<void> = Promise.resolve();

  const terminate = (reason: ExecTermination): void => {
    if (terminated !== null) {
      return;
    }
    terminated = reason;
    // The kill is retained, not discarded: the terminal event claims the process was stopped, and
    // the caller's fallback throws when even the container-level kill failed. Swallowing that
    // would report a still-running process as terminated. The extra `catch` only marks the
    // rejection handled so it is not reported as unhandled while the pump drains the stream —
    // `killed` still rejects for whoever awaits it.
    killed = kill(reason);
    killed.catch(() => undefined);
    stream.destroy();
  };
  const onAbort = (): void => {
    terminate('ABORTED');
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      terminate('ABORTED');
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  if (params.timeoutMs !== undefined) {
    cancelTimeout = schedule(() => {
      terminate('TIMEOUT');
    }, params.timeoutMs);
  }

  return {
    reason: () => terminated,
    killed: async () => killed,
    dispose: () => {
      cancelTimeout?.();
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Turns a hijacked exec stream into the contract's `ExecEvent` sequence.
 *
 * Yields every stdout/stderr frame in order and exactly one terminal `exit` event. A non-zero exit
 * code is data, never an exception. When the runner ends the exec itself — wall-clock timeout or
 * caller abort — the exit event carries `code: null` and the reason as `signal`, and the exit code
 * is not inspected because the process was not allowed to finish.
 *
 * @param params - Stream, parser, limits and the two daemon callbacks.
 * @yields Output events followed by the terminal `exit` event.
 * @throws DockerRunnerError when the stream fails for a reason other than our own termination, or
 *   when the exec had to be terminated and could not be killed even at the container level.
 */
export async function* pumpExecStream(params: PumpExecParams): AsyncGenerator<ExecEvent> {
  const { stream, demuxer, inspectExitCode } = params;
  const watch = watchTermination(params, params.scheduleTimeout ?? systemScheduleTimeout);

  try {
    for await (const chunk of stream) {
      yield* demuxer.push(chunk);
    }
  } catch (error) {
    // A stream that fails *because* we destroyed it is the expected end of a terminated exec.
    if (watch.reason() === null) {
      throw new DockerRunnerError('exec stream failed', { cause: error });
    }
  } finally {
    watch.dispose();
  }

  const reason = watch.reason();
  if (reason === null) {
    yield { type: 'exit', code: await inspectExitCode() };
    return;
  }
  // Rejects when the process could not be stopped at all; the caller must not be told the exec
  // ended when it is still running.
  await watch.killed();
  yield { type: 'exit', code: null, signal: reason };
}

/**
 * Rejects an exec reference that could escape the wrapper's argument list.
 *
 * @param execRef - Reference to validate.
 * @throws DockerRunnerError when the reference is not a UUID-shaped string.
 */
function assertSafeExecRef(execRef: string): void {
  if (!EXEC_REF_PATTERN.test(execRef)) {
    throw new DockerRunnerError(`invalid exec reference "${execRef}"`);
  }
}

/**
 * Wraps a command so its pid can be signalled from inside the container.
 *
 * The wrapper writes the shell's own pid to `${EXEC_PID_DIR}/<execRef>.pid` and then `exec`s the
 * real command, which replaces the shell while keeping that pid — so the recorded pid is the
 * process the caller wants to signal.
 *
 * @param execRef - UUID identifying this exec; becomes the pid file name.
 * @param cmd - The command and its arguments.
 * @returns Argument vector for Docker's `Cmd`.
 * @throws DockerRunnerError when `execRef` is not UUID-shaped.
 */
export function execWrapperCommand(execRef: string, cmd: readonly string[]): string[] {
  assertSafeExecRef(execRef);
  return [
    'sh',
    '-c',
    `mkdir -p ${EXEC_PID_DIR} && echo $$ > "${EXEC_PID_DIR}/$0.pid" && exec "$@"`,
    execRef,
    ...cmd,
  ];
}

/**
 * Builds the command that removes a finished exec's pid file.
 *
 * The wrapper cannot do this itself: it ends with `exec "$@"`, which replaces the shell, so no
 * trap of its own can ever run. Left in place the file outlives the process it names, and the
 * container recycles pids freely — a `signal` arriving late would then be delivered to whatever
 * process inherited that number. Removing the file turns that case back into "already finished".
 *
 * @param execRef - UUID of the exec whose pid file should go.
 * @returns Argument vector for Docker's `Cmd`; succeeds whether or not the file is still there.
 * @throws DockerRunnerError when `execRef` is not UUID-shaped.
 */
export function pidFileCleanupCommand(execRef: string): string[] {
  assertSafeExecRef(execRef);
  return ['sh', '-c', `rm -f "${EXEC_PID_DIR}/$0.pid"`, execRef];
}

/**
 * Builds the command that signals a previously wrapped exec.
 *
 * @param execRef - UUID of the exec to signal.
 * @param sig - Signal name to deliver; re-checked at runtime because it ends up in a shell command.
 * @returns Argument vector for Docker's `Cmd`; exits non-zero when the pid file is gone, which
 *   simply means the process already finished.
 * @throws DockerRunnerError when `execRef` is not UUID-shaped or `sig` is not a known signal.
 */
export function killCommand(execRef: string, sig: ExecSignal): string[] {
  assertSafeExecRef(execRef);
  if (!ALLOWED_SIGNALS.includes(sig)) {
    throw new DockerRunnerError(`unsupported signal "${sig}"`);
  }
  return ['sh', '-c', `kill -${sig} "$(cat "${EXEC_PID_DIR}/$0.pid")"`, execRef];
}
