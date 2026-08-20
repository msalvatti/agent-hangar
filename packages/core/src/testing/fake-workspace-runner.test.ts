/**
 * Unit tests for FakeWorkspaceRunner.
 *
 * Layer: unit.
 * Goal: create/exec (default echo and scripted), signal aborting an in-flight exec, snapshot
 * determinism, idempotent destroy, label listing, health, the virtual filesystem helpers and
 * the call log.
 * Mocks: fake timers for the create delay; no I/O.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecEvent, WorkspaceSpec } from '../runner/types.ts';

import { FakeClock } from './fake-clock.ts';
import { FakeWorkspaceRunner } from './fake-workspace-runner.ts';

const decoder = new TextDecoder();

function spec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    workspaceId: 'ws-1',
    kind: 'CHAT',
    image: 'agent-hangar/workspace:dev',
    env: {},
    limits: { cpus: 1, memoryBytes: 1024, pids: 64 },
    labels: { 'ah.instance': 'test', 'ah.kind': 'CHAT' },
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const out: ExecEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

async function next<T>(iterator: AsyncIterator<T>): Promise<T | undefined> {
  const result = await iterator.next();
  return result.done === true ? undefined : result.value;
}

function execRefOf(event: ExecEvent | undefined): string {
  return event?.type === 'started' ? event.execRef : '';
}

function text(event: ExecEvent | undefined): string {
  if (event?.type === 'stdout' || event?.type === 'stderr') {
    return decoder.decode(event.data);
  }
  return '';
}

describe('FakeWorkspaceRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * `create` returns a handle bound to the spec's workspace id with an opaque runner ref, records
   * the call, and `kind` is "fake" so `Workspace.runnerKind` can be asserted.
   */
  it('creates workspaces and records calls', async () => {
    const runner = new FakeWorkspaceRunner();
    const handle = await runner.create(spec());
    expect(runner.kind).toBe('fake');
    expect(handle.workspaceId).toBe('ws-1');
    expect(handle.runnerRef).toMatch(/^fake-\d+$/);
    expect(runner.calls[0]?.method).toBe('create');
    expect(runner.getWorkspace('ws-1')?.status).toBe('running');
  });

  /**
   * `createDelayMs` simulates a slow container start; the promise resolves only after the delay
   * and rejects when the caller's signal aborts first.
   */
  it('honours createDelayMs and abort during create', async () => {
    vi.useFakeTimers();
    const runner = new FakeWorkspaceRunner({ createDelayMs: 1000 });
    let settled = false;
    const pending = runner.create(spec()).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);

    const controller = new AbortController();
    const aborted = runner.create(spec({ workspaceId: 'ws-2' }), { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow();
  });

  /**
   * Default exec: `started` first (with an execRef), then stdin echoed to stdout (string,
   * bytes, or async chunks), then `exit 0`.
   */
  it('echoes stdin to stdout by default and yields started first', async () => {
    const runner = new FakeWorkspaceRunner();
    const handle = await runner.create(spec());

    const fromString = await collect(runner.exec(handle, { cmd: ['cat'], stdin: 'hello' }));
    expect(fromString[0]?.type).toBe('started');
    expect(text(fromString[1])).toBe('hello');
    expect(fromString[2]).toEqual({ type: 'exit', code: 0 });

    const fromBytes = await collect(
      runner.exec(handle, { cmd: ['cat'], stdin: new TextEncoder().encode('bytes') }),
    );
    expect(text(fromBytes[1])).toBe('bytes');

    async function* chunks(): AsyncIterable<Uint8Array> {
      yield await Promise.resolve(new TextEncoder().encode('a'));
      yield new TextEncoder().encode('b');
    }
    const fromIterable = await collect(runner.exec(handle, { cmd: ['cat'], stdin: chunks() }));
    expect(fromIterable.map(text).join('')).toBe('ab');

    const noStdin = await collect(runner.exec(handle, { cmd: ['true'] }));
    expect(noStdin).toEqual([
      { type: 'started', execRef: expect.any(String) as string },
      { type: 'exit', code: 0 },
    ]);
  });

  /**
   * Scripted exec: the first script whose `match` accepts the command wins; array events are
   * replayed verbatim after `started`; non-matching commands fall back to echo.
   */
  it('replays scripted events by command match', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [
        {
          match: (cmd) => cmd[0] === 'git',
          events: [
            { type: 'stderr', data: new TextEncoder().encode('fatal') },
            { type: 'exit', code: 128 },
          ],
        },
      ],
    });
    const handle = await runner.create(spec());
    const events = await collect(runner.exec(handle, { cmd: ['git', 'push'] }));
    expect(events.map((event) => event.type)).toEqual(['started', 'stderr', 'exit']);
    expect(events[2]).toEqual({ type: 'exit', code: 128 });
    const echoed = await collect(runner.exec(handle, { cmd: ['cat'], stdin: 'x' }));
    expect(text(echoed[1])).toBe('x');
  });

  /**
   * Signal support: a scripted long-running exec (factory form) is aborted by `signal()`; the
   * stream ends with `exit { code: null, signal: 'INT' }` and the script sees the abort signal.
   */
  it('aborts an in-flight scripted exec on signal', async () => {
    let sawAbort = false;
    const runner = new FakeWorkspaceRunner({
      scripts: [
        {
          match: (cmd) => cmd[0] === 'sleep',
          events: async function* (_spec, signal) {
            yield { type: 'stdout', data: new TextEncoder().encode('tick') };
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => {
                sawAbort = true;
                resolve();
              });
            });
            yield { type: 'stdout', data: new TextEncoder().encode('never') };
          },
        },
      ],
    });
    const handle = await runner.create(spec());
    const iterator = runner.exec(handle, { cmd: ['sleep', 'infinity'] })[Symbol.asyncIterator]();
    const execRef = execRefOf(await next(iterator));
    expect(execRef).not.toBe('');
    expect(text(await next(iterator))).toBe('tick');

    const pendingNext = next(iterator);
    await runner.signal(handle, execRef, 'INT');
    expect(await pendingNext).toEqual({ type: 'exit', code: null, signal: 'INT' });
    expect(await next(iterator)).toBeUndefined();
    expect(sawAbort).toBe(true);
    expect(runner.calls.some((call) => call.method === 'signal')).toBe(true);
  });

  /**
   * Cleanup errors: when an aborted script throws from its `finally` while being closed, the
   * rejection is swallowed (the exec already ended with `exit`) instead of crashing the process.
   */
  it('swallows cleanup errors of aborted scripts', async () => {
    let closed = false;
    const runner = new FakeWorkspaceRunner({
      scripts: [
        {
          match: () => true,
          events: async function* (_spec, signal) {
            try {
              yield { type: 'stdout', data: new Uint8Array([1]) };
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                  resolve();
                });
              });
              yield { type: 'stdout', data: new Uint8Array([2]) };
            } finally {
              closed = true;
              throw new Error('cleanup failed');
            }
          },
        },
      ],
    });
    const handle = await runner.create(spec());
    const iterator = runner.exec(handle, { cmd: ['x'] })[Symbol.asyncIterator]();
    const execRef = execRefOf(await next(iterator));
    await next(iterator);
    const pendingNext = next(iterator);
    await runner.signal(handle, execRef, 'TERM');
    expect(await pendingNext).toEqual({ type: 'exit', code: null, signal: 'TERM' });
    expect(await next(iterator)).toBeUndefined();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(closed).toBe(true);
  });

  /**
   * Signalling an unknown execRef is a no-op (the exec already finished), mirroring a runner
   * that tolerates late cancellation.
   */
  it('ignores signals for unknown execs', async () => {
    const runner = new FakeWorkspaceRunner();
    const handle = await runner.create(spec());
    await expect(runner.signal(handle, 'nope', 'KILL')).resolves.toBeUndefined();
  });

  /**
   * The exec's own `signal` (ExecSpec.signal) also ends the stream, including when it is
   * already aborted before the first event is pulled; array scripts stop early too.
   */
  it('honours ExecSpec.signal and stops array scripts on abort', async () => {
    const runner = new FakeWorkspaceRunner({
      scripts: [
        {
          match: () => true,
          events: [
            { type: 'stdout', data: new Uint8Array([1]) },
            { type: 'stdout', data: new Uint8Array([2]) },
            { type: 'exit', code: 0 },
          ],
        },
      ],
    });
    const handle = await runner.create(spec());

    const pre = new AbortController();
    pre.abort();
    const preAborted = await collect(runner.exec(handle, { cmd: ['x'], signal: pre.signal }));
    expect(preAborted.map((event) => event.type)).toEqual(['started', 'exit']);
    expect(preAborted[1]).toEqual({ type: 'exit', code: null, signal: 'ABORT' });

    const mid = new AbortController();
    const iterator = runner
      .exec(handle, { cmd: ['x'], signal: mid.signal })
      [Symbol.asyncIterator]();
    await next(iterator);
    await next(iterator);
    mid.abort();
    expect(await next(iterator)).toEqual({ type: 'exit', code: null, signal: 'ABORT' });
  });

  /**
   * Virtual filesystem and snapshot: files written through the helper show up in a
   * deterministic, sorted summary; git state can be overridden; `dirty` reflects files.
   */
  it('snapshots the virtual filesystem deterministically', async () => {
    const clock = new FakeClock(new Date('2026-08-19T10:00:00.000Z'));
    const runner = new FakeWorkspaceRunner({ clock });
    const handle = await runner.create(spec());
    expect((await runner.snapshot(handle)).git.dirty).toBe(false);

    runner.writeFile('ws-1', 'src/b.ts', 'bb');
    runner.writeFile('ws-1', 'src/a.ts', 'a');
    runner.setGitState('ws-1', { branch: 'agent/x', headSha: 'abc' });
    expect(runner.readFile('ws-1', 'src/a.ts')).toBe('a');
    expect(runner.readFile('ws-1', 'missing')).toBeUndefined();

    const snapshot = await runner.snapshot(handle);
    expect(snapshot.takenAt.toISOString()).toBe('2026-08-19T10:00:00.000Z');
    expect(snapshot.git).toEqual({
      branch: 'agent/x',
      headSha: 'abc',
      dirty: true,
      ahead: 0,
      behind: 0,
    });
    expect(snapshot.summary).toBe('src/a.ts (1 bytes)\nsrc/b.ts (2 bytes)');
  });

  /**
   * Destroy is idempotent and marks the workspace gone: health reports `gone`, files are
   * dropped, exec/snapshot throw, `list` no longer returns it, and a second destroy (or a
   * destroy of an unknown handle) is a no-op.
   */
  it('destroys idempotently and reports gone', async () => {
    const runner = new FakeWorkspaceRunner();
    const handle = await runner.create(spec());
    runner.writeFile('ws-1', 'f', 'x');
    await runner.destroy(handle);
    await runner.destroy(handle);
    await runner.destroy({ workspaceId: 'unknown', runnerRef: 'r' });
    expect(await runner.health(handle)).toEqual({ status: 'gone' });
    expect(await runner.health({ workspaceId: 'unknown', runnerRef: 'r' })).toEqual({
      status: 'gone',
    });
    expect(runner.getWorkspace('ws-1')?.files.size).toBe(0);
    expect(await runner.list({})).toEqual([]);
    await expect(collect(runner.exec(handle, { cmd: ['x'] }))).rejects.toThrow(/is gone/);
    await expect(runner.snapshot(handle)).rejects.toThrow(/is gone/);
    expect(() => {
      runner.writeFile('nope', 'f', 'x');
    }).toThrow(/unknown workspace/);
  });

  /**
   * Health reports uptime from the injected clock while the workspace runs.
   */
  it('reports healthy with uptime from the clock', async () => {
    const clock = new FakeClock();
    const runner = new FakeWorkspaceRunner({ clock });
    const handle = await runner.create(spec());
    clock.advance(5000);
    expect(await runner.health(handle)).toEqual({ status: 'healthy', uptimeMs: 5000 });
  });

  /**
   * `list` filters running workspaces by subset label match: an empty selector returns all,
   * a partial selector matches supersets, a mismatching value matches nothing.
   */
  it('lists workspaces by label subset', async () => {
    const runner = new FakeWorkspaceRunner();
    const a = await runner.create(
      spec({ workspaceId: 'a', labels: { 'ah.instance': 'x', 'ah.chat': '1' } }),
    );
    const b = await runner.create(
      spec({ workspaceId: 'b', labels: { 'ah.instance': 'x', 'ah.jobRun': '9' } }),
    );
    await runner.create(spec({ workspaceId: 'c', labels: { 'ah.instance': 'y' } }));
    expect((await runner.list({})).map((handle) => handle.workspaceId)).toEqual(['a', 'b', 'c']);
    expect(await runner.list({ 'ah.instance': 'x' })).toEqual([a, b]);
    expect(await runner.list({ 'ah.instance': 'x', 'ah.chat': '1' })).toEqual([a]);
    expect(await runner.list({ 'ah.instance': 'z' })).toEqual([]);
  });
});
