/**
 * Unit tests for the Docker exec stream plumbing.
 *
 * Layer: unit.
 * Goal: the frame parser reassembles Docker's multiplexed stream across arbitrary chunk
 * boundaries and refuses a corrupt framing; the stdin pump honours backpressure and always closes
 * stdin; the exec pump yields output in order followed by exactly one terminal event, and the two
 * runner-initiated endings (wall-clock timeout, caller abort) kill the process once and report
 * themselves as `signal` rather than as a thrown error.
 * Mocks: in-memory `PassThrough` streams, injected timer functions and Vitest fake timers; no
 * Docker daemon is involved.
 */
import { getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '../../errors.ts';
import type { ExecEvent, ExecSignal } from '../types.ts';

import { DockerRunnerError } from './errors.ts';
import {
  createDockerDemuxer,
  EXEC_PID_DIR,
  execWrapperCommand,
  killCommand,
  pidFileCleanupCommand,
  pumpExecStream,
  writeStdin,
} from './exec-stream.ts';
import type { PumpExecParams } from './exec-stream.ts';

/** Docker stream type for stdout frames. */
const STDOUT_TYPE = 1;

/** Docker stream type for stderr frames. */
const STDERR_TYPE = 2;

/** UUID-shaped reference used by the wrapper cases. */
const EXEC_REF = '11111111-2222-3333-4444-555555555555';

const decoder = new TextDecoder();

/**
 * Builds one Docker stream frame.
 *
 * @param type - Stream type byte (0/1 stdout, 2 stderr).
 * @param payload - Frame payload as text.
 * @returns The 8-byte header followed by the payload.
 */
function frame(type: number, payload: string): Uint8Array {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 4);
  return new Uint8Array(Buffer.concat([header, body]));
}

/**
 * Renders demuxed events as `type:text` pairs so assertions read as the stream did.
 *
 * @param events - Events to render.
 * @returns One string per event.
 */
function render(events: ExecEvent[]): string[] {
  return events.map((event) =>
    event.type === 'stdout' || event.type === 'stderr'
      ? `${event.type}:${decoder.decode(event.data)}`
      : event.type,
  );
}

/**
 * Drains a pump into an array.
 *
 * @param events - The generator returned by `pumpExecStream`.
 * @returns Every event it yielded.
 */
async function collect(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const collected: ExecEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/**
 * Builds pump parameters over a `PassThrough`, with spies on the two daemon callbacks.
 *
 * @param overrides - Fields to replace on the baseline parameters.
 * @returns The parameters plus the stream and the spies.
 */
function pumpFixture(overrides: Partial<PumpExecParams> = {}): {
  params: PumpExecParams;
  stream: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  inspectExitCode: ReturnType<typeof vi.fn>;
} {
  const stream = new PassThrough();
  const kill = vi.fn(async () => Promise.resolve());
  const inspectExitCode = vi.fn(async () => Promise.resolve(0));
  const params: PumpExecParams = {
    stream,
    demuxer: createDockerDemuxer(),
    kill,
    inspectExitCode,
    ...overrides,
  };
  return { params, stream, kill, inspectExitCode };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createDockerDemuxer', () => {
  /**
   * The happy path: one complete stdout frame and one complete stderr frame in separate chunks
   * map to the two output event kinds the contract defines.
   */
  it('demuxes stdout and stderr frames', () => {
    const demuxer = createDockerDemuxer();

    expect(render(demuxer.push(frame(STDOUT_TYPE, 'out')))).toEqual(['stdout:out']);
    expect(render(demuxer.push(frame(STDERR_TYPE, 'err')))).toEqual(['stderr:err']);
  });

  /**
   * Docker also uses stream type 0 for a stdin echo on non-TTY execs; it is output as far as the
   * caller is concerned and must not be mistaken for a framing error.
   */
  it('treats stream type 0 as stdout', () => {
    expect(render(createDockerDemuxer().push(frame(0, 'zero')))).toEqual(['stdout:zero']);
  });

  /**
   * Boundary: a socket can split anywhere, including inside the 8-byte header. No event may be
   * emitted until the header is complete, and the buffered bytes must be reported as pending.
   */
  it('reassembles a header split across chunks', () => {
    const demuxer = createDockerDemuxer();
    const full = frame(STDOUT_TYPE, 'hi');

    expect(demuxer.push(full.subarray(0, 3))).toEqual([]);
    expect(demuxer.pendingBytes()).toBe(3);
    expect(render(demuxer.push(full.subarray(3)))).toEqual(['stdout:hi']);
    expect(demuxer.pendingBytes()).toBe(0);
  });

  /**
   * Boundary: a payload split across three chunks must be reassembled in order, with nothing
   * emitted while the frame is incomplete.
   */
  it('reassembles a payload split across three chunks', () => {
    const demuxer = createDockerDemuxer();
    const full = frame(STDOUT_TYPE, 'abcdef');

    expect(demuxer.push(full.subarray(0, 9))).toEqual([]);
    expect(demuxer.push(full.subarray(9, 11))).toEqual([]);
    expect(render(demuxer.push(full.subarray(11)))).toEqual(['stdout:abcdef']);
  });

  /**
   * The opposite boundary: several frames can arrive in one chunk and must all be emitted, in
   * order, from a single `push`.
   */
  it('emits every frame contained in one chunk', () => {
    const chunk = Buffer.concat([frame(STDOUT_TYPE, 'a'), frame(STDERR_TYPE, 'b'), frame(1, 'c')]);

    expect(render(createDockerDemuxer().push(new Uint8Array(chunk)))).toEqual([
      'stdout:a',
      'stderr:b',
      'stdout:c',
    ]);
  });

  /**
   * A zero-length frame carries no output. Emitting it would put an empty `stdout` event into the
   * transcript, which downstream cannot distinguish from real output.
   */
  it('skips zero-length frames', () => {
    const demuxer = createDockerDemuxer();
    const chunk = Buffer.concat([frame(STDOUT_TYPE, ''), frame(STDOUT_TYPE, 'x')]);

    expect(render(demuxer.push(new Uint8Array(chunk)))).toEqual(['stdout:x']);
  });

  /**
   * An unknown stream type means the framing is out of sync; continuing would emit whatever bytes
   * follow as if they were output, so the parser fails loudly instead.
   */
  it('throws a protocol error for an unknown stream type', () => {
    expect(() => createDockerDemuxer().push(frame(7, 'x'))).toThrow(ProtocolError);
  });

  /**
   * A stream that ends mid-frame leaves bytes behind; `pendingBytes` is the diagnostic that tells
   * a caller the output was truncated rather than complete.
   */
  it('reports the bytes left over after a partial frame', () => {
    const demuxer = createDockerDemuxer();

    demuxer.push(frame(STDOUT_TYPE, 'complete'));
    demuxer.push(frame(STDOUT_TYPE, 'partial').subarray(0, 10));

    expect(demuxer.pendingBytes()).toBe(10);
  });
});

describe('writeStdin', () => {
  /**
   * A string payload is written once as UTF-8 and stdin is closed, so a process reading to EOF
   * (the agent runtime reads one NDJSON request) sees the end of input.
   */
  it('writes a string as UTF-8 and closes stdin', async () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));

    await writeStdin(stream, 'pîng');

    expect(Buffer.concat(written).toString('utf8')).toBe('pîng');
    expect(stream.writableEnded).toBe(true);
  });

  /**
   * A byte array is written verbatim — no encoding step may touch bytes the caller already framed.
   */
  it('writes a byte array verbatim', async () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));

    await writeStdin(stream, new Uint8Array([0, 1, 254]));

    expect([...Buffer.concat(written)]).toEqual([0, 1, 254]);
  });

  /**
   * An async iterable is drained chunk by chunk in order; this is how a streaming turn request is
   * fed to the runtime without buffering it whole.
   */
  it('drains an async iterable in order', async () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));

    async function* source(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(Buffer.from('a'));
      yield await Promise.resolve(Buffer.from('b'));
      yield await Promise.resolve(Buffer.from('c'));
    }

    await writeStdin(stream, source());

    expect(Buffer.concat(written).toString('utf8')).toBe('abc');
    expect(stream.writableEnded).toBe(true);
  });

  /**
   * Every chunk of an async source is raced against the caller's signal, and each race attaches an
   * abort listener. A race that does not detach its own listener therefore does not leak one
   * listener but one per chunk, all held for as long as the caller holds the signal — so the count
   * observed at the top of each pull is the guarantee, not just the count left at the end.
   */
  it('holds no more than one abort listener at a time while draining a source', async () => {
    const stream = new PassThrough();
    stream.resume();
    const controller = new AbortController();
    const attachedBeforeEachPull: number[] = [];

    async function* source(): AsyncIterable<Uint8Array> {
      for (const byte of [1, 2, 3, 4]) {
        attachedBeforeEachPull.push(getEventListeners(controller.signal, 'abort').length);
        yield await Promise.resolve(Buffer.from([byte]));
      }
    }

    await writeStdin(stream, source(), controller.signal);

    expect(attachedBeforeEachPull).toStrictEqual([0, 0, 0, 0]);
    expect(getEventListeners(controller.signal, 'abort')).toStrictEqual([]);
  });

  /**
   * The no-stdin case is the one that matters most: a process blocked on `read()` never exits, so
   * stdin has to be closed even when there was nothing to write.
   */
  it('closes stdin even when there is nothing to write', async () => {
    const stream = new PassThrough();

    await writeStdin(stream, undefined);

    expect(stream.writableEnded).toBe(true);
  });

  /**
   * Backpressure: a full stream returns `false` from `write`, and the pump must wait for `'drain'`
   * instead of queueing the whole payload in memory. A one-byte high-water mark forces the path.
   */
  it('waits for drain when the stream signals backpressure', async () => {
    const accepted: Buffer[] = [];
    let release: (() => void) | undefined;
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        accepted.push(chunk);
        release = (): void => {
          callback();
        };
      },
    });

    async function* source(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(Buffer.from('first'));
      yield await Promise.resolve(Buffer.from('second'));
    }

    const done = writeStdin(stream, source());
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();
    await vi.waitFor(() => {
      expect(accepted.length).toBe(2);
    });
    release?.();
    await done;

    expect(Buffer.concat(accepted).toString('utf8')).toBe('firstsecond');
  });

  /**
   * Cancellation: once the caller aborts, no further chunk is pulled from the iterable, but stdin
   * is still closed so the container-side process is not left waiting on a half-open pipe.
   */
  it('stops pulling from an aborted iterable and still closes stdin', async () => {
    const stream = new PassThrough();
    const written: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => written.push(chunk));
    const controller = new AbortController();
    let pulled = 0;

    async function* source(): AsyncIterable<Uint8Array> {
      pulled += 1;
      yield await Promise.resolve(Buffer.from('a'));
      controller.abort();
      pulled += 1;
      yield await Promise.resolve(Buffer.from('b'));
      pulled += 1;
      yield await Promise.resolve(Buffer.from('c'));
    }

    await writeStdin(stream, source(), controller.signal);

    expect(Buffer.concat(written).toString('utf8')).toBe('a');
    expect(pulled).toBe(2);
    expect(stream.writableEnded).toBe(true);
  });

  /**
   * Backpressure is the other door to the same hang. A stream destroyed while its buffer is full
   * never emits `'drain'`, so a write parked on that event would never settle — and the runner
   * awaits this writer before an exec is considered over, so the caller would never receive a
   * terminal event. The wait has to end when the exec does.
   */
  it('abandons a write parked on backpressure once aborted, and still closes stdin', async () => {
    // A stream that always reports a full buffer and never drains, standing in for the hijacked
    // stream after a timeout destroyed it.
    const stream = {
      write: () => false,
      once: () => undefined,
      end: () => {
        ended = true;
      },
    };
    let ended = false;
    const controller = new AbortController();

    const written = writeStdin(stream, 'payload that cannot be flushed', controller.signal);
    controller.abort();

    await expect(written).resolves.toBeUndefined();
    expect(ended).toBe(true);
  });

  /**
   * The hang that makes the timeout and the abort meaningless. A source whose `next()` never
   * settles cannot be caught by checking `signal.aborted` between chunks — the check is never
   * reached. The runner awaits this writer before an exec is considered over, so a pending `next()`
   * would hold that await open for good and no terminal event would ever reach the caller. The
   * abort has to win the race against the pending pull, and stdin must still be closed.
   */
  it('abandons a source whose next() never settles once aborted, and still closes stdin', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    let returned = false;

    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };

    const written = writeStdin(stream, source, controller.signal);
    controller.abort();

    await expect(written).resolves.toBeUndefined();
    expect(stream.writableEnded).toBe(true);
    expect(returned).toBe(true);
  });

  /**
   * A pull the abort abandoned can still fail afterwards — a source reading from a socket that
   * drops a moment later does exactly that. The abort is seen before this pull is raced at all, so
   * nothing else is watching the promise: its rejection has to be marked handled where it is
   * dropped. An unhandled rejection in Node is a process-level event, and this one would surface
   * long after the write it belonged to returned, inside whatever happened to be running then.
   */
  it('marks an abandoned pull handled when it fails after the abort', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    let failPull = (): void => {
      throw new Error('the pull was failed before it was made');
    };
    let pulls = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          pulls += 1;
          if (pulls === 1) {
            return Promise.resolve({ done: false as const, value: new Uint8Array([1]) });
          }
          // Aborted as this pull is handed over, so the write drops it without racing it — the
          // one path on which nothing else is left holding the promise.
          controller.abort();
          return new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
            failPull = () => {
              reject(new Error('the source went away'));
            };
          });
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    };

    const rejections: unknown[] = [];
    const collect = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', collect);
    try {
      await expect(writeStdin(stream, source, controller.signal)).resolves.toBeUndefined();

      failPull();
      // Node reports an unhandled rejection once the microtask queue has drained, so the check
      // has to happen a turn later than the rejection.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', collect);
    }

    expect(rejections).toStrictEqual([]);
    expect(stream.writableEnded).toBe(true);
  });

  /**
   * Closing the abandoned source is a courtesy to it, not a step the exec depends on. A source that
   * throws on `return()` must not turn a finished write into a failure, and stdin must still be
   * closed — the container-side process is waiting on that EOF.
   */
  it('ignores a source that throws while being closed', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();

    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => Promise.reject(new Error('source refused to close')),
      }),
    };

    const written = writeStdin(stream, source, controller.signal);
    controller.abort();

    await expect(written).resolves.toBeUndefined();
    expect(stream.writableEnded).toBe(true);
  });
});

describe('pumpExecStream', () => {
  /**
   * The nominal sequence: output events in stream order, then exactly one `exit` carrying the code
   * read back from the daemon.
   */
  it('yields output in order then the inspected exit code', async () => {
    const { params, stream } = pumpFixture();
    stream.write(frame(STDOUT_TYPE, 'out'));
    stream.write(frame(STDERR_TYPE, 'err'));
    stream.end();

    expect(render(await collect(pumpExecStream(params)))).toEqual([
      'stdout:out',
      'stderr:err',
      'exit',
    ]);
  });

  /**
   * A failing command is data, not an exception: the contract says `exec` never throws on a
   * non-zero exit, because the agent has to see the code and the stderr it produced.
   */
  it('reports a non-zero exit code without throwing', async () => {
    const { params, stream, inspectExitCode } = pumpFixture();
    inspectExitCode.mockResolvedValue(3);
    stream.end();

    expect(await collect(pumpExecStream(params))).toEqual([{ type: 'exit', code: 3 }]);
  });

  /**
   * Timeout path: the wall clock expires while the process is still running. The runner kills it
   * exactly once, reports `TIMEOUT`, and does NOT read an exit code — the process never finished,
   * so any code the daemon reports would be meaningless.
   */
  it('kills once and reports TIMEOUT when the wall clock expires', async () => {
    vi.useFakeTimers();
    const { params, stream, kill, inspectExitCode } = pumpFixture({ timeoutMs: 1_000 });
    stream.write(frame(STDOUT_TYPE, 'working'));

    const pending = collect(pumpExecStream(params));
    await vi.advanceTimersByTimeAsync(1_001);

    const events = await pending;
    expect(render(events)).toEqual(['stdout:working', 'exit']);
    expect(events.at(-1)).toEqual({ type: 'exit', code: null, signal: 'TIMEOUT' });
    expect(kill).toHaveBeenCalledExactlyOnceWith('TIMEOUT');
    expect(inspectExitCode).not.toHaveBeenCalled();
  });

  /**
   * A rejected kill is not a cosmetic failure. The caller's implementation already falls back to
   * killing the container and only rejects when that failed too, so the process is still running:
   * yielding `exit ... TIMEOUT` there would tell the caller the command stopped when it did not,
   * and the workspace would be reused with a runaway process in it. The failure must surface.
   */
  it('propagates a kill that could not stop the process, instead of reporting TIMEOUT', async () => {
    vi.useFakeTimers();
    const { params, kill } = pumpFixture({ timeoutMs: 500 });
    kill.mockRejectedValue(new Error('cannot terminate exec (TIMEOUT)'));

    const pending = collect(pumpExecStream(params));
    // The assertion is attached before the clock moves so the rejection is never momentarily
    // unhandled; advancing first would surface it as an unhandled rejection.
    const rejects = expect(pending).rejects.toThrow('cannot terminate exec (TIMEOUT)');
    await vi.advanceTimersByTimeAsync(501);

    await rejects;
  });

  /**
   * A signal that is already aborted when `exec` starts must terminate immediately rather than
   * waiting for output that will never come.
   */
  it('terminates immediately for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { params, kill } = pumpFixture({ signal: controller.signal });

    expect(await collect(pumpExecStream(params))).toEqual([
      { type: 'exit', code: null, signal: 'ABORTED' },
    ]);
    expect(kill).toHaveBeenCalledExactlyOnceWith('ABORTED');
  });

  /**
   * Cancellation mid-turn: the user hits stop while output is streaming. Everything already
   * demuxed is yielded, then the exec ends as `ABORTED`.
   */
  it('terminates when the signal aborts during the stream', async () => {
    const controller = new AbortController();
    const { params, stream, kill } = pumpFixture({ signal: controller.signal });
    stream.write(frame(STDOUT_TYPE, 'partial'));

    const pending = collect(pumpExecStream(params));
    await vi.waitFor(() => {
      expect(stream.readableFlowing).not.toBe(null);
    });
    controller.abort();

    expect(render(await pending)).toEqual(['stdout:partial', 'exit']);
    expect(kill).toHaveBeenCalledExactlyOnceWith('ABORTED');
  });

  /**
   * Race guard: a timeout that fires after the caller already aborted must not kill a second time
   * or overwrite the reported reason. Double-killing would send a signal to whatever pid the file
   * now names — potentially a different exec reusing it.
   */
  it('ignores a timeout that fires after an abort', async () => {
    const controller = new AbortController();
    let fireTimeout: (() => void) | undefined;
    const { params, kill } = pumpFixture({
      signal: controller.signal,
      timeoutMs: 1_000,
      scheduleTimeout: (callback) => {
        fireTimeout = callback;
        return () => undefined;
      },
    });

    const pending = collect(pumpExecStream(params));
    await vi.waitFor(() => {
      expect(fireTimeout).toBeDefined();
    });
    controller.abort();
    fireTimeout?.();

    expect(await pending).toEqual([{ type: 'exit', code: null, signal: 'ABORTED' }]);
    expect(kill).toHaveBeenCalledExactlyOnceWith('ABORTED');
  });

  /**
   * A genuine transport failure (socket reset, daemon restart) is not an exec result and must
   * surface as the runner's typed error with the cause attached.
   */
  it('raises a typed error when the stream fails on its own', async () => {
    const { params, stream } = pumpFixture();
    const pending = collect(pumpExecStream(params));
    await vi.waitFor(() => {
      expect(stream.readableFlowing).not.toBe(null);
    });
    stream.destroy(new Error('socket hang up'));

    await expect(pending).rejects.toThrow(DockerRunnerError);
  });

  /**
   * The timer must be cleared when the process exits on its own; a leaked timer would kill a
   * container that is already serving the next exec.
   */
  it('clears the timeout when the process exits first', async () => {
    vi.useFakeTimers();
    const { params, stream, kill } = pumpFixture({ timeoutMs: 1_000 });
    stream.end();

    expect(await collect(pumpExecStream(params))).toEqual([{ type: 'exit', code: 0 }]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('execWrapperCommand and killCommand', () => {
  /**
   * The wrapper is what makes cancellation possible at all: it records the shell's pid — preserved
   * across `exec "$@"` — in a tmpfs file named after the exec reference.
   */
  it('wraps a command so its pid is recorded', () => {
    expect(execWrapperCommand(EXEC_REF, ['git', 'status'])).toEqual([
      'sh',
      '-c',
      `mkdir -p ${EXEC_PID_DIR} && echo $$ > "${EXEC_PID_DIR}/$0.pid" && exec "$@"`,
      EXEC_REF,
      'git',
      'status',
    ]);
  });

  /**
   * Each signal name is interpolated into the kill command; all three of the contract's signals
   * must produce a well-formed command.
   */
  it.each(['INT', 'TERM', 'KILL'] as const)('builds the kill command for %s', (sig) => {
    expect(killCommand(EXEC_REF, sig)).toEqual([
      'sh',
      '-c',
      `kill -${sig} "$(cat "${EXEC_PID_DIR}/$0.pid")"`,
      EXEC_REF,
    ]);
  });

  /**
   * Security boundary: the signal name is interpolated into a `sh -c` string. It is typed as a
   * three-value union, but the value arrives in an HTTP request body, so a caller that skipped
   * validation would otherwise turn a cancel request into command injection. The check is here,
   * at the point where the string becomes a command.
   */
  it('refuses a signal name outside the known set', () => {
    const injected = 'KILL; id #' as ExecSignal;

    expect(() => killCommand(EXEC_REF, injected)).toThrow(DockerRunnerError);
    expect(() => killCommand(EXEC_REF, injected)).toThrow(/unsupported signal/);
  });

  /**
   * Security boundary: the reference is interpolated into a shell argument list, so anything
   * outside the UUID alphabet — quotes, `$(...)`, spaces, a shorter string — must be refused
   * before it reaches the daemon.
   */
  it.each([
    ['command substitution', '$(id)'],
    ['quote escape', `"; id; "`],
    ['too short', 'abc'],
    ['uppercase hex', '11111111-2222-3333-4444-55555555555A'],
    // A reference that merely contains a well-formed one is not a well-formed one: the pattern is
    // anchored at both ends, and either anchor removed lets everything before or after it through
    // into the argument list.
    ['a well-formed reference with something before it', `;id;${EXEC_REF}`],
    ['a well-formed reference with something after it', `${EXEC_REF};id;`],
  ])('rejects an exec reference containing a %s', (_case, execRef) => {
    // All three builders, because each interpolates the reference into a shell argument list and a
    // check is only a boundary where it is actually applied.
    for (const build of [
      () => execWrapperCommand(execRef, ['true']),
      () => killCommand(execRef, 'KILL'),
      () => pidFileCleanupCommand(execRef),
    ]) {
      expect(build).toThrow(DockerRunnerError);
      expect(build).toThrow(`invalid exec reference "${execRef}"`);
    }
  });

  /**
   * The cleanup runs after the wrapper has been replaced by the real command, so it is the only
   * thing that can remove the pid file. Built with anything but a shell and its command flag it
   * removes nothing, and a late signal then lands on whatever process inherited that pid.
   */
  it('builds the command that removes a finished exec pid file', () => {
    expect(pidFileCleanupCommand(EXEC_REF)).toStrictEqual([
      'sh',
      '-c',
      `rm -f "${EXEC_PID_DIR}/$0.pid"`,
      EXEC_REF,
    ]);
  });
});

describe('what the stream layer refuses and cleans up', () => {
  /**
   * A frame header is eight bytes and a frame of no payload is a whole frame: waiting for a ninth
   * byte before reading it leaves an empty frame sitting in the buffer for as long as the process
   * says nothing more, and the exit code behind it with it.
   */
  it('reads a frame whose header has just arrived and whose payload is empty', () => {
    const demuxer = createDockerDemuxer();
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(0, 4);

    expect(demuxer.push(header)).toStrictEqual([]);
    expect(demuxer.push(Buffer.from([1, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69]))).toStrictEqual([
      { type: 'stdout', data: new Uint8Array([0x68, 0x69]) },
    ]);
  });

  /**
   * The protocol has three stream types and nothing else. A fourth is a stream this runner is not
   * talking to, and the message names the type so the failure can be traced to the daemon that
   * produced it rather than to the parser that refused it.
   */
  it('names the stream type it does not know', () => {
    const demuxer = createDockerDemuxer();
    const frame = Buffer.alloc(8);
    frame.writeUInt8(7, 0);

    expect(() => demuxer.push(frame)).toThrow('unexpected docker stream type 7');
  });

  /**
   * An exec with no wall-clock limit runs until the process ends or the caller stops it. Scheduled
   * anyway, with no delay to schedule, the timer fires on the next turn of the loop and every such
   * exec is killed the moment it starts.
   */
  it('sets no timer for an exec that named no timeout', async () => {
    const scheduled: (number | undefined)[] = [];
    const { params, stream, kill } = pumpFixture({
      scheduleTimeout: (run, ms) => {
        scheduled.push(ms);
        const timer = setTimeout(run, ms);
        return () => {
          clearTimeout(timer);
        };
      },
    });
    stream.write(frame(STDOUT_TYPE, 'out'));
    setTimeout(() => {
      stream.end();
    }, 30);

    const events = await collect(pumpExecStream(params));

    expect(scheduled).toStrictEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(events.at(-1)).toStrictEqual({ type: 'exit', code: 0 });
  });

  /**
   * The listener the watch attaches belongs to the exec that attached it. Left in place, a turn
   * cancelled after its exec has already finished reaches back into a finished run and asks the
   * daemon to kill a process that is not there.
   */
  it('stops listening for cancellation once the exec is over', async () => {
    const controller = new AbortController();
    const { params, stream, kill } = pumpFixture({ signal: controller.signal });
    stream.end();

    await collect(pumpExecStream(params));
    controller.abort();

    expect(kill).not.toHaveBeenCalled();
  });

  /**
   * A stream that fails on its own is reported as this module's own error, naming what failed and
   * keeping the reason: without the cause the caller is told an exec stream failed and nothing
   * about why, which for a broken pipe and for a daemon restart reads exactly the same.
   */
  it('reports a stream failure with its reason attached', async () => {
    const { params, stream } = pumpFixture();
    const underlying = new Error('socket hang up');
    const events = pumpExecStream(params);
    queueMicrotask(() => {
      stream.destroy(underlying);
    });

    const failure = await collect(events).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DockerRunnerError);
    expect((failure as Error).message).toBe('exec stream failed');
    expect((failure as Error).cause).toBe(underlying);
  });

  /**
   * When the abort wins the race, the value that was being waited for is dropped — and a value
   * that turns out to be a rejection is dropped with it. Not marked as handled, that rejection
   * reaches the process as an unhandled one, which Node ends the worker over: a cancelled write
   * would take the runtime down with it.
   */
  it('drops a source failure that arrives after the cancellation', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          controller.abort();
          await Promise.resolve();
          throw new Error('source broke after the abort');
        },
        return: async () => Promise.resolve({ value: undefined, done: true as const }),
      }),
    };

    await expect(writeStdin(stream, source, controller.signal)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  /**
   * A source that has no way to be closed is still a source: `return` is optional on an async
   * iterator, and calling it unconditionally turns abandoning a plain generator-like object into a
   * type error thrown out of the writer's cleanup.
   */
  it('abandons a source that cannot be closed', async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          controller.abort();
          return Promise.resolve({
            value: new TextEncoder().encode('chunk'),
            done: false as const,
          });
        },
      }),
    };

    await expect(writeStdin(stream, source, controller.signal)).resolves.toBeUndefined();
  });
});
