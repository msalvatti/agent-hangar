/**
 * Running one turn inside a workspace and turning its output into events.
 *
 * Layer: service.
 *
 * Shared by chat turns and scheduled runs, which differ in what they persist, not in how they are
 * executed. The order inside the loop is the contract every other lane depends on: parse, redact,
 * publish, then persist. Publishing before persisting is what lets the UI stay live while the
 * database catches up; redacting before either is what makes both safe.
 *
 * Security: the bytes fed to the parser are produced by a process whose environment holds the
 * GitHub PAT and the OpenAI key. Nothing derived from them leaves this function unredacted — not
 * the events, not the stderr diagnostics, and not the message of a transport failure. A failure of
 * the publisher or of the repositories is reported by classification and never by message: its
 * text belongs to a driver that was configured with a connection string.
 */
import {
  agentEventSchema,
  createNdjsonParser,
  describeClientFailure,
  encodeLine,
} from '@agent-hangar/core';
import type {
  AgentEvent,
  AgentEventType,
  ExecEvent,
  NdjsonParser,
  Redactor,
  TurnRequest,
  WorkspaceHandle,
  WorkspaceRunner,
} from '@agent-hangar/core';

import { isTransportError } from '../errors.js';

import type { CancellationWatch } from './cancellation.js';
import { CANCEL_GRACE_MS, EXEC_GRACE_MS, RUNTIME_CMD } from './constants.js';
import type { ProcessorDeps } from './types.js';

/** Where a redacted event is persisted; the executor has already published it. */
export interface TurnSink {
  /**
   * Persists one event.
   *
   * @param event - The event, already redacted.
   */
  onEvent(event: AgentEvent): Promise<void>;
}

/** How a turn ended. */
export type TurnTerminal =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'exited'
  | 'timeout'
  /** The workspace runner itself failed as infrastructure rather than as work (daemon unreachable). */
  | 'transport-error'
  /** The workspace runner itself failed in a way a retry would repeat. */
  | 'runner-error'
  /** Publishing or persisting an event failed; the runner and the runtime were both fine. */
  | 'client-error';

/** What every outcome carries. */
interface OutcomeBase {
  /** Exit code of the runtime, `null` when it was signalled or never started. */
  exitCode: number | null;
  /** How many lines the parser rejected. */
  protocolErrors: number;
}

/**
 * The runtime emitted a terminal event, so the sink has already persisted the outcome.
 *
 * The caller must not write it again; it only has to release the workspace.
 */
export interface ReportedOutcome extends OutcomeBase {
  terminal: 'completed' | 'failed' | 'cancelled';
  reportedByRuntime: true;
  /** Present for `failed`, which is the only reported outcome that describes a failure. */
  error?: { code: string; message: string };
}

/**
 * The runtime never said how the turn ended — it was cancelled without answering, exited silently,
 * timed out, or could not be started at all.
 *
 * The caller is the only one that can close the turn out, so the description is always present.
 */
export interface UnreportedOutcome extends OutcomeBase {
  terminal: TurnTerminal;
  reportedByRuntime: false;
  error: { code: string; message: string };
}

/** What the executor observed. */
export type ExecOutcome = ReportedOutcome | UnreportedOutcome;

/** Inputs of {@link executeRuntimeTurn}. */
export interface ExecuteRuntimeTurnInput {
  /** Workspace to run in. */
  handle: WorkspaceHandle;
  /** The request written to the runtime's stdin. */
  request: TurnRequest;
  /** Persistence of each redacted event. */
  sink: TurnSink;
  /**
   * The cancellation subscription of this turn, opened by the caller before it prepared the
   * workspace, and closed by the caller once the outcome is written.
   */
  watch: CancellationWatch;
}

/** Failure codes the executor synthesises when the runtime described no failure itself. */
export const RUNTIME_EXIT_CODE = 'runtime_exit';

/** Failure code used when the runner's wall-clock limit fired. */
export const TURN_TIMEOUT_CODE = 'turn_timeout';

/** Failure code used when the worker could not talk to the runner at all. */
export const TRANSPORT_CODE = 'transport';

/** Failure code used when the runner failed for a reason a retry would reproduce. */
export const RUNNER_ERROR_CODE = 'runner_error';

/** Failure code used when the event stream could not be published or persisted. */
export const CLIENT_ERROR_CODE = 'client_error';

/**
 * Raised when publishing or persisting an event failed, as opposed to the exec stream itself.
 *
 * Security: the two are told apart so their messages can be. A Redis or Postgres driver builds its
 * message from the connection string it was configured with, password included, and the redactor
 * knows only the GitHub and OpenAI credentials — so a client failure is reported by classification
 * and never by message, while a runner failure, whose text is the daemon's, is redacted and kept.
 */
class EventDeliveryFailure extends Error {
  /**
   * @param cause - What the publisher or the sink rejected with.
   */
  constructor(cause: unknown) {
    super('publishing or persisting a turn event failed', { cause });
    this.name = 'EventDeliveryFailure';
  }
}

/** Signal the runner reports when it enforced `timeoutMs`. */
const TIMEOUT_SIGNAL = 'TIMEOUT';

const decoder = new TextDecoder();

/**
 * Redacts an event and proves the result is still a valid event.
 *
 * Redaction rewrites strings anywhere in the object, so the result is validated rather than
 * assumed: an entry that no longer satisfies the protocol would be handed to the SSE route and to
 * the repositories as if it did. A redacted event that fails validation is replaced by the
 * parser's own rejection event, which is structurally incapable of carrying anything.
 *
 * @param redactor - The worker's redactor, holding the revealed credentials.
 * @param event - The event as parsed from the runtime's output.
 * @returns The redacted event, or a `protocol.error` describing its size.
 */
export function redactAgentEvent(redactor: Redactor, event: AgentEvent): AgentEvent {
  const scrubbed = redactor.redactJson(event);
  const result = agentEventSchema.safeParse(scrubbed);
  if (result.success) {
    return result.data;
  }
  return {
    type: 'protocol.error',
    reason: 'schema-violation',
    length: JSON.stringify(scrubbed).length,
  };
}

/** Mutable state of one execution. */
interface ExecState {
  /** Incremental reader of the runtime's stdout; one per stream, as its contract requires. */
  parser: NdjsonParser<AgentEvent>;
  execRef: string | undefined;
  cancelRequested: boolean;
  terminal: ReportedOutcome['terminal'] | undefined;
  error: { code: string; message: string } | undefined;
  protocolErrors: number;
  exitCode: number | null;
  exitSignal: string | undefined;
  killTimer: ReturnType<typeof setTimeout> | undefined;
}

/** The three events that end a turn, and what each means. */
const TERMINAL_BY_EVENT: Partial<Record<AgentEventType, ReportedOutcome['terminal']>> = {
  'turn.completed': 'completed',
  'turn.failed': 'failed',
  'turn.cancelled': 'cancelled',
};

/**
 * Maps a terminal event to the outcome it represents.
 *
 * @param event - The event just handled.
 * @returns The terminal kind, or `undefined` when the event was not terminal.
 */
function terminalOf(event: AgentEvent): ReportedOutcome['terminal'] | undefined {
  return TERMINAL_BY_EVENT[event.type];
}

/**
 * Classifies an execution that produced no terminal event.
 *
 * @param state - What the loop observed.
 * @returns The outcome and the failure it should be recorded as.
 */
function classifySilentExit(state: ExecState): {
  terminal: TurnTerminal;
  code: string;
  message: string;
} {
  if (state.exitSignal === TIMEOUT_SIGNAL) {
    return { terminal: 'timeout', code: TURN_TIMEOUT_CODE, message: 'turn timed out' };
  }
  if (state.cancelRequested) {
    return { terminal: 'cancelled', code: RUNTIME_EXIT_CODE, message: 'turn cancelled' };
  }
  if (state.exitCode === null || state.exitCode === 0) {
    return {
      terminal: 'exited',
      code: RUNTIME_EXIT_CODE,
      message: 'runtime ended without a terminal event',
    };
  }
  return {
    terminal: 'exited',
    code: RUNTIME_EXIT_CODE,
    message: `runtime exited with code ${state.exitCode}`,
  };
}

/**
 * Delivers a signal to the running exec, tolerating a runner that no longer knows it.
 *
 * @param runner - The workspace runner.
 * @param handle - Workspace the exec runs in.
 * @param execRef - Reference the runner handed out.
 * @param signal - Signal to deliver.
 * @param deps - For the log line when delivery fails.
 */
async function deliverSignal(
  runner: WorkspaceRunner,
  handle: WorkspaceHandle,
  execRef: string,
  signal: 'INT' | 'KILL',
  deps: ProcessorDeps,
): Promise<void> {
  try {
    await runner.signal(handle, execRef, signal);
  } catch (error) {
    deps.logger.warn({ err: error, signal }, 'delivering a cancellation signal failed');
  }
}

/**
 * Starts the cancellation of a running exec: `SIGINT` now, `SIGKILL` if it is ignored.
 *
 * The escalation timer is unreferenced so a worker with nothing else to do can still exit, and it
 * is cleared in the executor's `finally` so a turn that answered promptly never gets a stray kill.
 *
 * @param deps - Runner and logger.
 * @param handle - Workspace the exec runs in.
 * @param state - Execution state; its `killTimer` is set here.
 */
function beginCancellation(deps: ProcessorDeps, handle: WorkspaceHandle, state: ExecState): void {
  const { execRef } = state;
  if (execRef === undefined || state.killTimer !== undefined) {
    return;
  }
  void deliverSignal(deps.runner, handle, execRef, 'INT', deps);
  const timer = setTimeout(() => {
    if (state.terminal === undefined) {
      void deliverSignal(deps.runner, handle, execRef, 'KILL', deps);
    }
  }, CANCEL_GRACE_MS);
  timer.unref();
  state.killTimer = timer;
}

/**
 * Publishes one redacted event and persists it, in that order.
 *
 * @param deps - Publisher.
 * @param input - The execution inputs, for the sink and the stream key.
 * @param safe - The event, already redacted.
 * @throws EventDeliveryFailure When either half failed, so the caller can tell a client outage
 *   apart from a runner one.
 */
async function deliverEvent(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
  safe: AgentEvent,
): Promise<void> {
  try {
    await deps.publisher.publish(input.watch.key, safe);
    await input.sink.onEvent(safe);
  } catch (error) {
    throw new EventDeliveryFailure(error);
  }
}

/**
 * Redacts, publishes and persists one parsed event.
 *
 * @param deps - Redactor, publisher and logger.
 * @param input - The execution inputs, for the sink and the stream key.
 * @param state - Execution state; terminal kind and rejected-line count are updated here.
 * @param event - The event as parsed.
 */
async function handleEvent(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
  state: ExecState,
  event: AgentEvent,
): Promise<void> {
  const safe = redactAgentEvent(deps.redactor, event);
  if (safe.type === 'protocol.error') {
    state.protocolErrors += 1;
    deps.logger.warn(
      { reason: safe.reason, length: safe.length },
      'runtime produced an invalid line',
    );
  }
  await deliverEvent(deps, input, safe);
  const terminal = terminalOf(safe);
  if (terminal !== undefined) {
    state.terminal = terminal;
    if (safe.type === 'turn.failed') {
      state.error = safe.error;
    }
  }
}

/**
 * Applies one event of the exec stream.
 *
 * @param deps - Redactor, publisher and logger.
 * @param input - The execution inputs, for the sink and the stream key.
 * @param state - Execution state, updated in place.
 * @param event - What the runner reported.
 */
async function consumeExecEvent(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
  state: ExecState,
  event: ExecEvent,
): Promise<void> {
  switch (event.type) {
    case 'started':
      state.execRef = event.execRef;
      if (state.cancelRequested) {
        // The cancellation arrived before the runner handed out a reference, so there was nothing
        // to signal then; this is the retry.
        beginCancellation(deps, input.handle, state);
      }
      break;
    case 'stdout':
      for (const parsed of state.parser.push(event.data)) {
        await handleEvent(deps, input, state, parsed);
      }
      break;
    case 'stderr':
      deps.logger.debug(
        { line: deps.redactor.redact(decoder.decode(event.data)) },
        'runtime stderr',
      );
      break;
    case 'exit':
      state.exitCode = event.code;
      state.exitSignal = event.signal;
      break;
  }
}

/**
 * Kills the process of an exec this worker is about to stop reading.
 *
 * Abandoning the loop disposes the runner's generator, and its cleanup unregisters the exec and
 * removes the pid file that names the process — after which nothing can address it, and the
 * command inside the container runs on: holding the workspace, writing to the filesystem the next
 * turn of the same chat will reuse, until the collector destroys the container some minutes later.
 * So the signal goes out first, while the generator is still suspended at its yield and the pid
 * file is still there.
 *
 * It is `KILL` rather than the `INT` a cancellation sends. A graceful stop exists to let the
 * runtime write a terminal event, and this path is taken precisely because the stream that would
 * carry it can no longer be published or persisted; nobody is left to read a clean exit, there is
 * no reader to wait for the escalation a cancellation would follow with, and a runtime that
 * ignored the gentler signal would leave exactly the process this exists to remove.
 *
 * @param deps - Runner and logger.
 * @param input - The execution inputs, for the workspace handle.
 * @param state - Execution state, for the reference the runner handed out.
 */
async function stopAbandonedExec(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
  state: ExecState,
): Promise<void> {
  const { execRef } = state;
  if (execRef === undefined) {
    // Nothing was started: the runner hands the reference out with its first event, so there is no
    // process to address.
    return;
  }
  await deliverSignal(deps.runner, input.handle, execRef, 'KILL', deps);
}

/**
 * Applies one exec event, stopping the process rather than walking away from it.
 *
 * Any failure here ends the loop, and the loop is the only thing reading that process. What threw
 * does not change that, so the exec is killed before the failure is allowed to propagate.
 *
 * @param deps - The processor's collaborators.
 * @param input - The execution inputs.
 * @param state - Execution state, updated in place.
 * @param event - What the runner reported.
 * @throws unknown Whatever applying the event threw, once the process is stopped.
 */
async function consumeOrStopExec(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
  state: ExecState,
  event: ExecEvent,
): Promise<void> {
  try {
    await consumeExecEvent(deps, input, state, event);
  } catch (error) {
    await stopAbandonedExec(deps, input, state);
    throw error;
  }
}

/**
 * Builds the outcome of a turn the runtime described itself.
 *
 * @param state - What the loop observed.
 * @param terminal - The terminal event it reported.
 * @returns The reported outcome.
 */
function reportedOutcome(state: ExecState, terminal: ReportedOutcome['terminal']): ReportedOutcome {
  return {
    terminal,
    reportedByRuntime: true,
    exitCode: state.exitCode,
    ...(state.error === undefined ? {} : { error: state.error }),
    protocolErrors: state.protocolErrors,
  };
}

/**
 * Classifies a failure of the exec loop.
 *
 * A stream that breaks after the runtime has already reported its outcome does not undo it: the
 * event was published and persisted, the caller would otherwise write a failure over a finished
 * turn, and what actually failed — the socket, the driver — says nothing about how the turn went.
 *
 * @param deps - Logger, for the failure that is being kept out of the turn's record.
 * @param state - What the loop observed before it broke.
 * @param error - What it broke with.
 * @returns The outcome the caller records.
 */
function failedOutcome(deps: ProcessorDeps, state: ExecState, error: unknown): ExecOutcome {
  const reported = state.terminal;
  if (reported !== undefined) {
    // Described rather than logged whole: what broke may be the publisher or a repository, whose
    // error carries the connection string it was configured with.
    deps.logger.warn(
      { failure: describeClientFailure(error) },
      'the exec stream failed after the turn had reported its outcome',
    );
    return reportedOutcome(state, reported);
  }
  if (error instanceof EventDeliveryFailure) {
    return {
      terminal: 'client-error',
      reportedByRuntime: false,
      exitCode: null,
      error: { code: CLIENT_ERROR_CODE, message: describeClientFailure(error.cause) },
      protocolErrors: state.protocolErrors,
    };
  }
  const retryable = isTransportError(error);
  return {
    terminal: retryable ? 'transport-error' : 'runner-error',
    reportedByRuntime: false,
    exitCode: null,
    error: {
      code: retryable ? TRANSPORT_CODE : RUNNER_ERROR_CODE,
      message: describeExecFailure(deps.redactor, error),
    },
    protocolErrors: state.protocolErrors,
  };
}

/**
 * Builds the state one execution mutates as it goes.
 *
 * @param watch - The cancellation subscription the caller opened before preparing the workspace.
 * @returns Fresh state, already carrying a cancellation that arrived during that preparation: it
 *   is honoured as soon as the runner hands out something to signal, rather than being lost.
 */
function newExecState(watch: CancellationWatch): ExecState {
  return {
    parser: createNdjsonParser(agentEventSchema),
    execRef: undefined,
    cancelRequested: watch.requested(),
    terminal: undefined,
    error: undefined,
    protocolErrors: 0,
    exitCode: null,
    exitSignal: undefined,
    killTimer: undefined,
  };
}

/**
 * Runs the turn and streams its events.
 *
 * @param deps - The processor's collaborators.
 * @param input - Workspace, request, sink and the cancellation watch the caller opened.
 * @returns How the turn ended.
 */
export async function executeRuntimeTurn(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
): Promise<ExecOutcome> {
  const state = newExecState(input.watch);

  input.watch.onCancel(() => {
    state.cancelRequested = true;
    beginCancellation(deps, input.handle, state);
  });

  try {
    for await (const event of deps.runner.exec(input.handle, {
      cmd: RUNTIME_CMD,
      stdin: encodeLine(input.request),
      timeoutMs: input.request.limits.maxTurnMs + EXEC_GRACE_MS,
    })) {
      await consumeOrStopExec(deps, input, state, event);
    }
    for (const parsed of state.parser.flush()) {
      await handleEvent(deps, input, state, parsed);
    }
  } catch (error) {
    return failedOutcome(deps, state, error);
  } finally {
    if (state.killTimer !== undefined) {
      clearTimeout(state.killTimer);
    }
  }

  const reported = state.terminal;
  if (reported !== undefined) {
    return reportedOutcome(state, reported);
  }
  const silent = classifySilentExit(state);
  return {
    terminal: silent.terminal,
    reportedByRuntime: false,
    exitCode: state.exitCode,
    error: { code: silent.code, message: silent.message },
    protocolErrors: state.protocolErrors,
  };
}

/**
 * Describes a failure of the exec stream itself.
 *
 * @param redactor - Applied to the message, which a driver may have built from its configuration.
 * @param error - What the runner rejected with.
 * @returns A redacted one-line description.
 */
function describeExecFailure(redactor: Redactor, error: unknown): string {
  return redactor.redact(error instanceof Error ? error.message : String(error));
}
