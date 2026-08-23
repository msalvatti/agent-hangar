/**
 * Unit tests for the runtime turn executor.
 *
 * Layer: unit.
 * Goal: the credentials of the turn reaching the container as a file placed for that one
 * execution and never as part of its environment, the refusal to start a turn whose credentials
 * are not configured, the ordering guarantee (redact, publish, then persist), the cancellation
 * escalation from
 * `SIGINT` to `SIGKILL`, a cancellation that arrived before the exec did, redacted stderr
 * diagnostics, the refusal to publish a redacted event that no longer satisfies the protocol, an
 * outcome the runtime reported surviving a stream that breaks afterwards, and a publisher or sink
 * failure described by classification rather than by its message.
 * Mocks: a runner whose exec is driven by hand, so a turn can be held open across fake timers.
 */
import { DEFAULT_CHAT_TURN_LIMITS, encodeLine, turnRequestSchema } from '@agent-hangar/core';
import type {
  AgentEvent,
  ExecEvent,
  ExecSignal,
  ExecSpec,
  Redactor,
  TurnRequest,
  WorkspaceHandle,
} from '@agent-hangar/core';
import { FakeWorkspaceRunner, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectionRefused,
  createTestContainer,
  FakeSecretsService,
  lastExecSpec,
} from '../testing/index.js';
import type { TestContainer } from '../testing/index.js';

import { openCancellationWatch } from './cancellation.js';
import { CANCEL_GRACE_MS, SECRETS_MISSING_CODE, SECRETS_MISSING_MESSAGE } from './constants.js';
import { CLIENT_ERROR_CODE, executeRuntimeTurn, redactAgentEvent } from './turn-executor.js';
import type { TurnSink } from './turn-executor.js';

const HANDLE: WorkspaceHandle = { workspaceId: 'ws-1', runnerRef: 'ref-1' };

const REQUEST: TurnRequest = turnRequestSchema.parse({
  protocolVersion: 1,
  turnId: 'turn-1',
  model: 'test-model',
  instructions: 'do the thing',
  items: [],
  repo: {
    url: 'https://github.com/octocat/Hello-World',
    baseBranch: 'main',
    workBranch: 'agent/x',
  },
  limits: DEFAULT_CHAT_TURN_LIMITS,
  prepare: { clone: true },
});

/** A promise a test resolves when it wants the held exec to finish. */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Builds a resolvable promise.
 *
 * @returns The promise and its resolver.
 */
function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * A runner whose exec stays open until the test feeds it, and whose signals never end it.
 *
 * That is how a runtime that ignores `SIGINT` behaves, which is the case the escalation exists
 * for; the fake runner cannot produce it because its own `signal` aborts the exec.
 */
class DrivenRunner extends FakeWorkspaceRunner {
  readonly signals: ExecSignal[] = [];

  private readonly queue: ExecEvent[] = [];
  private wake = deferred();
  private ended = false;

  constructor(prefix: readonly AgentEvent[] = []) {
    super();
    for (const event of prefix) {
      this.emit(event);
    }
  }

  /** Queues one agent event on stdout. */
  emit(event: AgentEvent): void {
    this.queue.push({ type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) });
    this.wake.resolve();
  }

  /** Ends the exec with the given code. */
  end(code = 0): void {
    this.queue.push({ type: 'exit', code });
    this.ended = true;
    this.wake.resolve();
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    yield { type: 'started', execRef: 'exec-1' };
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.ended) {
        return;
      }
      await this.wake.promise;
      this.wake = deferred();
    }
  }

  override signal(_handle: WorkspaceHandle, _execRef: string, sig: ExecSignal): Promise<void> {
    this.signals.push(sig);
    return Promise.resolve();
  }
}

/** A runner that streams the given exec events verbatim. */
class ScriptedExecRunner extends FakeWorkspaceRunner {
  constructor(private readonly events: readonly ExecEvent[]) {
    super();
  }

  override async *exec(handle: WorkspaceHandle, spec: ExecSpec): AsyncIterable<ExecEvent> {
    // Recorded the way the fake records it, so a test can ask what the worker asked for — and so
    // "no exec happened" is a statement about the worker rather than about this override.
    this.calls.push({ method: 'exec', args: [handle, spec] });
    for (const event of this.events) {
      yield await Promise.resolve(event);
    }
  }
}

/** A runner whose exec stream breaks after the events the test gave it. */
class BreakingRunner extends FakeWorkspaceRunner {
  constructor(
    private readonly events: readonly ExecEvent[],
    private readonly failure: unknown,
  ) {
    super();
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    for (const event of this.events) {
      yield await Promise.resolve(event);
    }
    throw this.failure;
  }
}

/**
 * A runner that records whether a signal arrived before its exec was disposed.
 *
 * The real Docker runner removes the pid file in the generator's `finally`, so a signal sent after
 * disposal addresses nothing. `disposedAt` and `signalledAt` are what let a test prove the worker
 * signals while the exec can still be reached.
 */
class DisposalRecordingRunner extends FakeWorkspaceRunner {
  readonly events: string[] = [];

  constructor(private readonly stdout: readonly AgentEvent[]) {
    super();
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    try {
      yield await Promise.resolve({ type: 'started' as const, execRef: 'exec-1' });
      for (const event of this.stdout) {
        yield { type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) };
      }
      yield { type: 'exit', code: 0 };
    } finally {
      // What the Docker runner's own `finally` does: unregister the exec and drop the pid file.
      this.events.push('disposed');
    }
  }

  override signal(_handle: WorkspaceHandle, _execRef: string, sig: ExecSignal): Promise<void> {
    this.events.push(`signal:${sig}`);
    return Promise.resolve();
  }
}

/** A runner that yields output without ever handing out an exec reference. */
class RefLessRunner extends FakeWorkspaceRunner {
  readonly signals: ExecSignal[] = [];

  override async *exec(): AsyncIterable<ExecEvent> {
    yield await Promise.resolve({
      type: 'stdout',
      data: new TextEncoder().encode(encodeLine({ type: 'prepare.progress', message: 'x' })),
    });
  }

  override signal(_handle: WorkspaceHandle, _execRef: string, sig: ExecSignal): Promise<void> {
    this.signals.push(sig);
    return Promise.resolve();
  }
}

/** A runner whose exec cannot be started, rejecting with whatever the test supplies. */
class RejectingRunner extends FakeWorkspaceRunner {
  constructor(private readonly failure: unknown) {
    super();
  }

  override async *exec(): AsyncIterable<ExecEvent> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** Collects what the sink was asked to persist. */
function recordingSink(): { sink: TurnSink; seen: AgentEvent[] } {
  const seen: AgentEvent[] = [];
  return {
    seen,
    sink: {
      onEvent: (event) => {
        seen.push(event);
        return Promise.resolve();
      },
    },
  };
}

/**
 * Runs the executor with the container's collaborators, opening and closing the watch around it
 * exactly as a processor does.
 */
async function execute(
  container: TestContainer,
  sink: TurnSink,
): Promise<Awaited<ReturnType<typeof executeRuntimeTurn>>> {
  const watch = await openCancellationWatch(container, REQUEST.turnId);
  try {
    return await executeRuntimeTurn(container, { handle: HANDLE, request: REQUEST, sink, watch });
  } finally {
    await watch.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The records the container collected, parsed back from the lines pino wrote. */
function records(logs: string[]): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** One stdout frame carrying an agent event. */
function frame(event: AgentEvent): ExecEvent {
  return { type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) };
}

describe('what the executor makes of an exec that reported no outcome', () => {
  /**
   * An ordinary turn produces no invalid lines and says nothing about any. The count is what a
   * reader takes as "the runtime and this worker disagree about the protocol", and raised for
   * every well-formed event it would say that of every turn ever run.
   */
  it('counts no invalid line for a turn that produced none', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        frame({ type: 'prepare.progress', message: 'Cloning…' }),
        frame({
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'done',
        }),
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome.protocolErrors).toBe(0);
    expect(container.logs.join('')).not.toContain('runtime produced an invalid line');
  });

  /**
   * A terminal event is not unsaid by whatever the runtime prints afterwards. A runtime that
   * reports it is done and then emits one more heartbeat has still reported an outcome, and a turn
   * that forgot it would be recorded as one that simply stopped.
   */
  it('keeps the outcome a runtime reported before its last words', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        frame({
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'done',
        }),
        frame({ type: 'heartbeat', at: '2026-01-01T00:00:01.000Z' }),
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toMatchObject({ terminal: 'completed', reportedByRuntime: true });
  });

  /**
   * And the failure a runtime described is not unsaid by a later terminal event either. A runtime
   * that reports a failure and is then cancelled has still said why it failed, and that reason is
   * what the user is shown — a cancellation carries none of its own.
   */
  it('keeps the reason a failed turn gave when a cancellation follows it', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        frame({
          type: 'turn.failed',
          error: { code: 'model_refused', message: 'the model refused the request' },
        }),
        frame({ type: 'turn.cancelled' }),
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toMatchObject({
      terminal: 'cancelled',
      reportedByRuntime: true,
      error: { code: 'model_refused', message: 'the model refused the request' },
    });
  });

  /**
   * The escalation is disarmed when the turn ends, and this is the case that proves it: the
   * runtime never acknowledged the Stop, so nothing in the state says the turn is over — only the
   * exec ending does. A timer left armed fires into a chat whose container outlives the turn, and
   * sends a `SIGKILL` against an exec reference the next turn may already be using.
   */
  it('disarms the escalation when a turn ends without acknowledging the stop', async () => {
    vi.useFakeTimers();
    const runner = new DrivenRunner([{ type: 'prepare.progress', message: 'Cloning…' }]);
    const container = createTestContainer({ runner });
    const pending = execute(container, recordingSink().sink);
    await vi.advanceTimersByTimeAsync(0);

    container.commands.emitCancel(REQUEST.turnId);
    await vi.advanceTimersByTimeAsync(0);
    runner.end(0);
    const outcome = await pending;

    expect(outcome).toMatchObject({ terminal: 'cancelled', reportedByRuntime: false });
    expect(runner.signals).toEqual(['INT']);

    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS * 4);
    expect(runner.signals).toEqual(['INT']);
  });

  /**
   * The escalation timer never holds the process open. A worker that has finished its jobs and been
   * asked to stop must exit, and a referenced timer would keep the event loop alive for the whole
   * cancellation grace after the turn it belonged to was over.
   */
  it('leaves the escalation timer unreferenced', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const runner = new DrivenRunner();
    const container = createTestContainer({ runner });
    const watch = await openCancellationWatch(container, REQUEST.turnId);
    const running = executeRuntimeTurn(container, {
      handle: HANDLE,
      request: REQUEST,
      sink: recordingSink().sink,
      watch,
    });
    await Promise.resolve();
    container.commands.emitCancel(REQUEST.turnId);
    runner.end(0);
    await running;
    await watch.close();

    const armed = timers.mock.results.map((result) => result.value as NodeJS.Timeout);
    expect(armed).not.toHaveLength(0);
    expect(armed.map((timer) => timer.hasRef())).toStrictEqual(armed.map(() => false));
  });

  /**
   * Each ending is a different thing to tell the user, and the four are told apart by evidence the
   * runtime did not give: the runner's own `TIMEOUT` signal, a Stop this worker sent, and the exit
   * code. Collapsed into one, a turn the user stopped would be recorded as a runtime that died and
   * a turn that ran out of time as one that ended for no reason.
   */
  it.each([
    [
      'the runner enforced the wall clock',
      { type: 'exit' as const, code: null, signal: 'TIMEOUT' as const },
      { terminal: 'timeout', code: 'turn_timeout', message: 'turn timed out' },
    ],
    [
      'the runtime exited cleanly without saying anything',
      { type: 'exit' as const, code: 0 },
      {
        terminal: 'exited',
        code: 'runtime_exit',
        message: 'runtime ended without a terminal event',
      },
    ],
    [
      'the runtime was killed and left no code',
      { type: 'exit' as const, code: null },
      {
        terminal: 'exited',
        code: 'runtime_exit',
        message: 'runtime ended without a terminal event',
      },
    ],
    [
      'the runtime exited nonzero',
      { type: 'exit' as const, code: 3 },
      { terminal: 'exited', code: 'runtime_exit', message: 'runtime exited with code 3' },
    ],
  ])('records %s', async (_case, exit, expected) => {
    const container = createTestContainer({ runner: new ScriptedExecRunner([exit]) });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toMatchObject({
      terminal: expected.terminal,
      reportedByRuntime: false,
      error: { code: expected.code, message: expected.message },
    });
  });

  /**
   * A turn this worker stopped is a cancellation even when the runtime never acknowledged it: the
   * user asked, the exec is over, and recording it as a runtime that died would blame the tool for
   * something the user did.
   */
  it('records a turn it stopped as cancelled', async () => {
    const container = createTestContainer({ runner: new DrivenRunner() });
    const runner = container.runner as DrivenRunner;
    const watch = await openCancellationWatch(container, REQUEST.turnId);
    const running = executeRuntimeTurn(container, {
      handle: HANDLE,
      request: REQUEST,
      sink: recordingSink().sink,
      watch,
    });
    await Promise.resolve();
    container.commands.emitCancel(REQUEST.turnId);
    runner.end(0);

    const outcome = await running;
    await watch.close();

    expect(outcome).toMatchObject({
      terminal: 'cancelled',
      reportedByRuntime: false,
      error: { code: 'runtime_exit', message: 'turn cancelled' },
    });
  });

  /**
   * The three terminal events are mapped one to one, and the failure the runtime described is kept
   * with the outcome rather than replaced by one this worker invents.
   */
  it.each([
    ['turn.completed', 'completed'],
    ['turn.cancelled', 'cancelled'],
  ])('takes %s at its word', async (type, terminal) => {
    const event =
      type === 'turn.completed'
        ? ({
            type: 'turn.completed',
            usage: { inputTokens: 1, outputTokens: 1 },
            steps: 1,
            finalMessage: 'done',
          } as AgentEvent)
        : ({ type: 'turn.cancelled' } as AgentEvent);
    const container = createTestContainer({
      runner: new ScriptedExecRunner([frame(event), { type: 'exit', code: 0 }]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toMatchObject({ terminal, reportedByRuntime: true });
  });

  /**
   * And a failure the runtime described keeps its own code and message: that is what the user is
   * shown, and a turn recorded as "the runtime ended" would throw away the diagnosis it gave.
   */
  it('keeps the failure a turn.failed carried', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        frame({
          type: 'turn.failed',
          error: { code: 'model_refused', message: 'the model refused the request' },
        }),
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toMatchObject({
      terminal: 'failed',
      reportedByRuntime: true,
      error: { code: 'model_refused', message: 'the model refused the request' },
    });
  });

  /**
   * A completed turn carries no `error` key at all. Present but empty, every consumer that tests
   * for one — the row's `error` column, the UI's failure banner — would report a failure on a turn
   * that succeeded.
   */
  it('leaves no error on an outcome that has none', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        frame({
          type: 'turn.completed',
          usage: { inputTokens: 1, outputTokens: 1 },
          steps: 1,
          finalMessage: 'done',
        }),
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(Object.hasOwn(outcome, 'error')).toBe(false);
  });

  /**
   * Lines the runtime produced that are not protocol are counted and reported one by one. The
   * count is what tells a reader whether a turn was noisy or broken, and it only ever goes up.
   */
  it('counts and reports every line that was not protocol', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'stdout', data: new TextEncoder().encode('not json at all\n') },
        { type: 'stdout', data: new TextEncoder().encode('{"type":"nope"}\n') },
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome.protocolErrors).toBe(2);
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'runtime produced an invalid line',
        reason: 'invalid-json',
        length: 15,
      }),
    );
  });

  /**
   * The exec is given the turn's own limit plus a grace, so the runner's timeout is a backstop
   * behind the runtime's rather than in front of it. Subtracted instead, the backstop fires first
   * and every long turn is reported as a transport timeout.
   */
  it('asks for a wall clock later than the deadline the turn carries', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([{ type: 'exit', code: 0 }]),
    });

    await execute(container, recordingSink().sink);

    expect(lastExecSpec(container).timeoutMs).toBe(REQUEST.limits.maxTurnMs + 60_000);
    expect(lastExecSpec(container).timeoutMs).toBeGreaterThan(REQUEST.limits.maxTurnMs);
  });
});

describe('executeRuntimeTurn and the credentials of the turn', () => {
  /**
   * The credentials belong to this execution and to nothing else. A container serves every turn of
   * a chat until the collector reclaims it, so anything handed over when it was built would stay
   * readable inside it — through `/proc/1/environ` for an environment entry — for as long as it
   * stands. The runner places the file immediately before the process starts and the runtime
   * unlinks it as it reads it, so what is asserted here is that the file is on the exec and the
   * secret is nowhere else on it.
   */
  it('places both credentials as a file on the exec and nowhere in its environment', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'exit', code: 0 },
      ]),
    });

    await execute(container, recordingSink().sink);

    const spec = lastExecSpec(container);
    expect(spec.files).toStrictEqual([
      {
        path: '/opt/agent-runtime/handoff/credentials.json',
        content: JSON.stringify({ githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY }),
      },
    ]);
    expect(JSON.stringify(spec.env ?? {})).not.toContain(GITHUB_CANARY);
    expect(JSON.stringify(spec.env ?? {})).not.toContain(OPENAI_CANARY);
  });

  /**
   * Registered before the exec, so everything that execution produces is scrubbed against the two
   * values — including in a container an earlier process of this worker created, which is exactly
   * the case a per-create registration used to miss after a restart.
   */
  it('registers both credentials with the redactor before the runtime starts', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'exit', code: 0 },
      ]),
    });
    const register = vi.spyOn(container.redactor, 'register');

    await execute(container, recordingSink().sink);

    expect(register).toHaveBeenCalledExactlyOnceWith([GITHUB_CANARY, OPENAI_CANARY]);
    expect(container.redactor.redact(`x ${OPENAI_CANARY}`)).toBe('x [REDACTED]');
  });

  /**
   * The window the reveal opens, and the reason the state is captured after it rather than before.
   *
   * Stop is offered while a turn is preparing, and revealing two credentials is two decryptions
   * against the database — long enough for a cancellation to land in the middle of it. The watch
   * does not replay a request to a listener registered afterwards, so a `requested()` read taken
   * before the reveal would miss exactly the requests that arrive during it, and the user's Stop
   * would do nothing while the container ran the turn to completion. Driven by making the reveal
   * itself the moment the cancellation arrives.
   */
  it('honours a cancellation that arrives while the credentials are being revealed', async () => {
    const runner = new DrivenRunner();
    const container = createTestContainer({ runner });
    const watch = await openCancellationWatch(container, REQUEST.turnId);
    const reveal = container.secrets.reveal.bind(container.secrets);
    vi.spyOn(container.secrets, 'reveal').mockImplementation(async (key) => {
      container.commands.emitCancel(REQUEST.turnId);
      return reveal(key);
    });
    const { sink } = recordingSink();

    const pending = executeRuntimeTurn(container, {
      handle: HANDLE,
      request: REQUEST,
      sink,
      watch,
    });
    runner.end();
    const outcome = await pending;
    await watch.close();

    expect(watch.requested()).toBe(true);
    expect(runner.signals).toEqual(['INT']);
    expect(outcome.terminal).toBe('cancelled');
  });

  /**
   * Asked of every turn and not only of every create, because the container outlives the create: an
   * operator who removes a credential after the workspace was built must not have the next turn run
   * in it anyway. Nothing is started, and what the user is told is what Settings can act on.
   */
  it('refuses to start the runtime when a credential is not configured', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'exit', code: 0 },
      ]),
      secrets: new FakeSecretsService(),
    });

    const outcome = await execute(container, recordingSink().sink);

    expect(outcome).toStrictEqual({
      terminal: 'runner-error',
      reportedByRuntime: false,
      exitCode: null,
      error: { code: SECRETS_MISSING_CODE, message: SECRETS_MISSING_MESSAGE },
      protocolErrors: 0,
    });
    expect(container.runner.calls.some((entry) => entry.method === 'exec')).toBe(false);
  });
});

describe('executeRuntimeTurn', () => {
  /**
   * Every event is published before it is persisted: the UI must be able to run ahead of the
   * database, never behind it.
   */
  it('publishes each event before persisting it', async () => {
    const event: AgentEvent = { type: 'prepare.progress', message: 'Cloning…' };
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) },
        { type: 'exit', code: 0 },
      ]),
    });
    const order: string[] = [];
    const publish = container.publisher.publish.bind(container.publisher);
    vi.spyOn(container.publisher, 'publish').mockImplementation((turnId, published) => {
      order.push('publish');
      return publish(turnId, published);
    });

    const outcome = await execute(container, {
      onEvent: () => {
        order.push('persist');
        return Promise.resolve();
      },
    });

    expect(order).toEqual(['publish', 'persist']);
    expect(outcome.reportedByRuntime).toBe(false);
    expect(container.commands.subscriptions).toBe(0);
  });

  /**
   * A trailing line with no newline is still an event; the runtime is not obliged to end its
   * output with one.
   */
  it('parses a trailing line without a newline', async () => {
    const line = JSON.stringify({ type: 'turn.cancelled' });
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'stdout', data: new TextEncoder().encode(line) },
        { type: 'exit', code: 0 },
      ]),
    });
    const { sink, seen } = recordingSink();

    const outcome = await execute(container, sink);

    expect(seen).toEqual([{ type: 'turn.cancelled' }]);
    expect(outcome).toMatchObject({ terminal: 'cancelled', reportedByRuntime: true });
  });

  /**
   * A runtime that ignores `SIGINT` is killed once the grace period expires, and not before.
   */
  it('escalates a cancellation from SIGINT to SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const runner = new DrivenRunner([{ type: 'prepare.progress', message: 'Cloning…' }]);
    const container = createTestContainer({ runner });
    const { sink } = recordingSink();
    const pending = execute(container, sink);
    await vi.advanceTimersByTimeAsync(0);

    container.commands.emitCancel(REQUEST.turnId);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.signals).toEqual(['INT']);

    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
    expect(runner.signals).toEqual(['INT', 'KILL']);

    runner.end();
    const outcome = await pending;
    expect(outcome.terminal).toBe('cancelled');
  });

  /**
   * A second cancellation while one is already in flight changes nothing: the escalation timer is
   * armed once, so a user clicking twice cannot bring the kill forward.
   */
  it('ignores a repeated cancellation', async () => {
    vi.useFakeTimers();
    const runner = new DrivenRunner();
    const container = createTestContainer({ runner });
    const { sink } = recordingSink();
    const pending = execute(container, sink);
    await vi.advanceTimersByTimeAsync(0);

    container.commands.emitCancel(REQUEST.turnId);
    container.commands.emitCancel(REQUEST.turnId);
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.signals).toEqual(['INT']);
    runner.end();
    await pending;
  });

  /**
   * A runtime that answers the signal is never killed: the timer sees a terminal event and stands
   * down.
   */
  it('does not kill a runtime that answered the signal', async () => {
    vi.useFakeTimers();
    const runner = new DrivenRunner([{ type: 'prepare.progress', message: 'Cloning…' }]);
    const container = createTestContainer({ runner });
    const { sink } = recordingSink();
    const pending = execute(container, sink);
    await vi.advanceTimersByTimeAsync(0);

    container.commands.emitCancel(REQUEST.turnId);
    await vi.advanceTimersByTimeAsync(0);
    runner.emit({ type: 'turn.cancelled' });
    await vi.advanceTimersByTimeAsync(0);

    // The exec is still open, so the escalation timer fires while the turn is alive — and stands
    // down, because the runtime already answered.
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS);
    expect(runner.signals).toEqual(['INT']);

    runner.end();
    const outcome = await pending;
    expect(outcome).toMatchObject({ terminal: 'cancelled', reportedByRuntime: true });

    // And the escalation is disarmed on the way out. A timer left armed fires into a turn that is
    // over — against an exec reference the next turn of this chat may already be using, since a
    // chat's container outlives the turn that created it.
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS * 4);
    expect(runner.signals).toEqual(['INT']);
  });

  /**
   * A cancellation that arrives before the runner handed out an exec reference is not lost: it is
   * delivered as soon as there is something to signal.
   */
  it('delivers a cancellation that raced the exec starting', async () => {
    const runner = new DrivenRunner();
    const container = createTestContainer({ runner });
    const subscribe = container.commands.subscribe.bind(container.commands);
    vi.spyOn(container.commands, 'subscribe').mockImplementation(async (turnId, handlers) => {
      const stop = await subscribe(turnId, handlers);
      handlers.onCancel();
      return stop;
    });
    const { sink } = recordingSink();

    const pending = execute(container, sink);
    runner.end();
    await pending;

    expect(runner.signals).toEqual(['INT']);
  });

  /**
   * A signal the runner refuses is logged rather than thrown: the turn is already being torn down
   * and there is nothing better to do about it.
   */
  it('logs a signal the runner refused', async () => {
    const runner = new DrivenRunner();
    vi.spyOn(runner, 'signal').mockRejectedValue(new Error('exec is gone'));
    const container = createTestContainer({ runner });
    const subscribe = container.commands.subscribe.bind(container.commands);
    vi.spyOn(container.commands, 'subscribe').mockImplementation(async (turnId, handlers) => {
      const stop = await subscribe(turnId, handlers);
      handlers.onCancel();
      return stop;
    });
    const { sink } = recordingSink();

    const pending = execute(container, sink);
    runner.end();
    await pending;
    await Promise.resolve();

    // Which signal could not be delivered, and what the runner said: an `INT` that failed leaves a
    // turn running that the user asked to stop, and a `KILL` that failed leaves a container the
    // collector will have to reap.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'delivering a cancellation signal failed',
        signal: 'INT',
        err: expect.objectContaining({ message: 'exec is gone' }) as unknown,
      }),
    );
  });

  /**
   * A rejection that is not an `Error` still yields a message rather than `undefined`; the runner
   * contract types it as `unknown` and a driver may reject with anything.
   */
  it('describes a rejection that is not an error', async () => {
    const container = createTestContainer({ runner: new RejectingRunner('daemon said no') });
    const { sink } = recordingSink();

    const outcome = await execute(container, sink);

    expect(outcome).toMatchObject({
      terminal: 'runner-error',
      error: { message: 'daemon said no' },
    });
  });

  /**
   * Diagnostics the runtime writes to stderr are logged, and they are redacted first: they are
   * produced by a process whose environment holds both credentials.
   */
  it('logs redacted stderr diagnostics', async () => {
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'stderr', data: new TextEncoder().encode(`fatal: ${GITHUB_CANARY} rejected\n`) },
        { type: 'exit', code: 0 },
      ]),
    });
    const { sink } = recordingSink();

    await execute(container, sink);

    // The diagnostic itself is on the line, scrubbed. A record that carried no line at all is a
    // record of the fact that the runtime said something, which is nothing an operator can use.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({ msg: 'runtime stderr', line: 'fatal: [REDACTED] rejected\n' }),
    );
    expect(container.logs.join('')).not.toContain(GITHUB_CANARY);
  });

  /**
   * A sink that throws is the database failing, not the runner. It is classified as a client
   * failure and described without repeating a message a driver built from its connection string,
   * and the command subscription is released either way.
   */
  it('reports a failure to persist without repeating its message', async () => {
    const event: AgentEvent = { type: 'prepare.progress', message: 'Cloning…' };
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) },
        { type: 'exit', code: 0 },
      ]),
    });

    const outcome = await execute(container, {
      onEvent: () => Promise.reject(new Error('database is down')),
    });

    expect(outcome).toMatchObject({
      terminal: 'client-error',
      reportedByRuntime: false,
      // The code is written out as well as read from the export: the web app matches on this word
      // to tell a turn that failed because of this worker's own infrastructure from one the model
      // or the runtime failed.
      error: { code: 'client_error', message: 'unknown' },
    });
    expect(CLIENT_ERROR_CODE).toBe('client_error');
    expect(JSON.stringify(outcome)).not.toContain('database is down');
    expect(container.commands.subscriptions).toBe(0);
  });

  /**
   * A publisher that cannot reach Redis is a client failure too, and never the daemon's: reporting
   * it as a transport error would fail the workspace and reject the job for something the runner
   * had no part in. What is recorded is the driver's classification, never its message, which
   * carries the connection string with its password.
   */
  it('reports a failure to publish by classification, not as a runner failure', async () => {
    const event: AgentEvent = { type: 'prepare.progress', message: 'Cloning…' };
    const container = createTestContainer({
      runner: new ScriptedExecRunner([
        { type: 'started', execRef: 'exec-1' },
        { type: 'stdout', data: new TextEncoder().encode(encodeLine(event)) },
        { type: 'exit', code: 0 },
      ]),
    });
    vi.spyOn(container.publisher, 'publish').mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED redis://ah:hunter2@cache:6379'), {
        code: 'ECONNREFUSED',
      }),
    );
    const { sink } = recordingSink();

    const outcome = await execute(container, sink);

    expect(outcome).toMatchObject({
      terminal: 'client-error',
      error: { code: CLIENT_ERROR_CODE, message: 'ECONNREFUSED' },
    });
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });

  /**
   * A stream that breaks after the runtime has already reported how the turn went does not undo
   * it: the terminal event was published and persisted, and returning an unreported failure would
   * have the caller write `turn.failed` over a run that succeeded.
   */
  it('keeps an outcome the runtime reported when the stream then breaks', async () => {
    const completed: AgentEvent = {
      type: 'turn.completed',
      usage: { inputTokens: 1, outputTokens: 2 },
      steps: 1,
      finalMessage: 'done',
    };
    const container = createTestContainer({
      runner: new BreakingRunner(
        [
          { type: 'started', execRef: 'exec-1' },
          { type: 'stdout', data: new TextEncoder().encode(encodeLine(completed)) },
        ],
        connectionRefused(),
      ),
    });
    const { sink, seen } = recordingSink();

    const outcome = await execute(container, sink);

    expect(outcome).toMatchObject({ terminal: 'completed', reportedByRuntime: true });
    expect(seen).toEqual([completed]);
    // Classified, never quoted: what broke may be the publisher or a repository, whose message is
    // built from the connection string it was configured with. A line naming nothing at all would
    // leave an operator with a warning they cannot act on.
    expect(records(container.logs)).toContainEqual(
      expect.objectContaining({
        msg: 'the exec stream failed after the turn had reported its outcome',
        failure: 'ECONNREFUSED',
      }),
    );
  });

  /**
   * Giving up on the stream must not leave the command running. The runner's cleanup removes the
   * pid file that names the process, so a signal sent after the loop is abandoned would address
   * nothing — the kill has to go out while the exec can still be reached, and the recorded order
   * is what proves it does.
   */
  it('kills the exec before abandoning it when an event cannot be delivered', async () => {
    const runner = new DisposalRecordingRunner([{ type: 'prepare.progress', message: 'Cloning…' }]);
    const container = createTestContainer({ runner });
    vi.spyOn(container.publisher, 'publish').mockRejectedValue(new Error('redis is gone'));
    const { sink } = recordingSink();

    const outcome = await execute(container, sink);

    expect(outcome.terminal).toBe('client-error');
    expect(runner.events).toEqual(['signal:KILL', 'disposed']);
  });

  /**
   * A process that was never started cannot be addressed: the runner hands its reference out with
   * the exec's first event, so there is nothing to signal and nothing to fail on.
   */
  it('signals nothing when the runner never handed out a reference', async () => {
    const runner = new RefLessRunner();
    const container = createTestContainer({ runner });
    vi.spyOn(container.publisher, 'publish').mockRejectedValue(new Error('redis is gone'));
    const { sink } = recordingSink();

    const outcome = await execute(container, sink);

    expect(outcome.terminal).toBe('client-error');
    expect(runner.signals).toEqual([]);
  });

  /**
   * Stop is offered while a turn is still preparing, and the request is published to whoever is
   * listening at that moment. A cancellation the watch caught before the exec existed is therefore
   * delivered as soon as there is a process to signal, instead of being lost with the preparation.
   */
  it('signals a cancellation that arrived before the exec started', async () => {
    const runner = new DrivenRunner();
    const container = createTestContainer({ runner });
    const watch = await openCancellationWatch(container, REQUEST.turnId);
    container.commands.emitCancel(REQUEST.turnId);
    const { sink } = recordingSink();

    const pending = executeRuntimeTurn(container, {
      handle: HANDLE,
      request: REQUEST,
      sink,
      watch,
    });
    runner.end();
    const outcome = await pending;
    await watch.close();

    expect(watch.requested()).toBe(true);
    expect(runner.signals).toEqual(['INT']);
    expect(outcome.terminal).toBe('cancelled');
  });
});

describe('redactAgentEvent', () => {
  /**
   * The usual case: strings are scrubbed and the event still satisfies the protocol.
   */
  it('scrubs an event and keeps it valid', () => {
    const redactor = createTestContainer().redactor;
    redactor.register([GITHUB_CANARY]);

    const safe = redactAgentEvent(redactor, {
      type: 'assistant.message',
      text: `token ${GITHUB_CANARY}`,
    });

    expect(safe).toEqual({ type: 'assistant.message', text: 'token [REDACTED]' });
  });

  /**
   * A redacted event that no longer satisfies the protocol is replaced rather than published: the
   * SSE route and the repositories are entitled to assume every entry parses.
   */
  it('replaces a redacted event that no longer parses', () => {
    const broken: Redactor = {
      register: () => undefined,
      redact: (input) => input,
      redactJson: () => ({ type: 'not-an-event' }),
    };

    const safe = redactAgentEvent(broken, { type: 'turn.cancelled' });

    expect(safe).toMatchObject({ type: 'protocol.error', reason: 'schema-violation' });
  });
});
