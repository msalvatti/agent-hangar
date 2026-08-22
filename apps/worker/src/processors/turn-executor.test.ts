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

    expect(container.logs.join('')).toContain('delivering a cancellation signal failed');
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

    const logged = container.logs.join('');
    expect(logged).toContain('runtime stderr');
    expect(logged).not.toContain(GITHUB_CANARY);
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
      error: { code: CLIENT_ERROR_CODE, message: 'unknown' },
    });
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
    expect(container.logs.join('')).toContain('after the turn had reported its outcome');
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
