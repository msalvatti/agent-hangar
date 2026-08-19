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
import { PassThrough, Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '../../errors.js';
import type { ExecEvent } from '../types.js';

import { DockerRunnerError } from './errors.js';
import {
  createDockerDemuxer,
  EXEC_PID_DIR,
  execWrapperCommand,
  killCommand,
  pumpExecStream,
  writeStdin,
} from './exec-stream.js';
import type { PumpExecParams } from './exec-stream.js';

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
   * A kill that itself fails must not become the exec's outcome: the caller's implementation has
   * its own container-level fallback, and the stream is destroyed regardless.
   */
  it('still reports TIMEOUT when the kill rejects', async () => {
    vi.useFakeTimers();
    const { params, kill } = pumpFixture({ timeoutMs: 500 });
    kill.mockRejectedValue(new Error('exec create failed'));

    const pending = collect(pumpExecStream(params));
    await vi.advanceTimersByTimeAsync(501);

    expect(await pending).toEqual([{ type: 'exit', code: null, signal: 'TIMEOUT' }]);
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
      setTimeoutFn: ((callback: () => void) => {
        fireTimeout = callback;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
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
   * Security boundary: the reference is interpolated into a shell argument list, so anything
   * outside the UUID alphabet — quotes, `$(...)`, spaces, a shorter string — must be refused
   * before it reaches the daemon.
   */
  it.each([
    ['command substitution', '$(id)'],
    ['quote escape', `"; id; "`],
    ['too short', 'abc'],
    ['uppercase hex', '11111111-2222-3333-4444-55555555555A'],
  ])('rejects an exec reference containing a %s', (_case, execRef) => {
    expect(() => execWrapperCommand(execRef, ['true'])).toThrow(DockerRunnerError);
    expect(() => killCommand(execRef, 'KILL')).toThrow(DockerRunnerError);
  });
});
