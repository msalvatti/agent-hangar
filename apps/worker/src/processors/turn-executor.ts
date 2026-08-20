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
 * the events, not the stderr diagnostics, and not the message of a transport failure.
 */
import { agentEventSchema, createNdjsonParser, encodeLine } from '@agent-hangar/core';
import type {
  AgentEvent,
  AgentEventType,
  Redactor,
  TurnRequest,
  WorkspaceHandle,
  WorkspaceRunner,
} from '@agent-hangar/core';

import { isTransportError } from '../errors.js';

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
  /** The workspace runner itself failed in a way that is worth retrying (daemon unreachable). */
  | 'transport-error'
  /** The workspace runner itself failed in a way a retry would repeat. */
  | 'runner-error';

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
  /** Id whose command channel is subscribed and whose event stream is published to. */
  cancelKey: string;
}

/** Failure codes the executor synthesises when the runtime described no failure itself. */
export const RUNTIME_EXIT_CODE = 'runtime_exit';

/** Failure code used when the runner's wall-clock limit fired. */
export const TURN_TIMEOUT_CODE = 'turn_timeout';

/** Failure code used when the worker could not talk to the runner at all. */
export const TRANSPORT_CODE = 'transport';

/** Failure code used when the runner failed for a reason a retry would reproduce. */
export const RUNNER_ERROR_CODE = 'runner_error';

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
  await deps.publisher.publish(input.cancelKey, safe);
  await input.sink.onEvent(safe);
  const terminal = terminalOf(safe);
  if (terminal !== undefined) {
    state.terminal = terminal;
    if (safe.type === 'turn.failed') {
      state.error = safe.error;
    }
  }
}

/**
 * Runs the turn and streams its events.
 *
 * @param deps - The processor's collaborators.
 * @param input - Workspace, request, sink and cancellation key.
 * @returns How the turn ended.
 */
export async function executeRuntimeTurn(
  deps: ProcessorDeps,
  input: ExecuteRuntimeTurnInput,
): Promise<ExecOutcome> {
  const parser = createNdjsonParser(agentEventSchema);
  const state: ExecState = {
    execRef: undefined,
    cancelRequested: false,
    terminal: undefined,
    error: undefined,
    protocolErrors: 0,
    exitCode: null,
    exitSignal: undefined,
    killTimer: undefined,
  };

  const unsubscribe = await deps.commands.subscribe(input.cancelKey, {
    onCancel: () => {
      state.cancelRequested = true;
      beginCancellation(deps, input.handle, state);
    },
  });

  try {
    for await (const event of deps.runner.exec(input.handle, {
      cmd: RUNTIME_CMD,
      stdin: encodeLine(input.request),
      timeoutMs: input.request.limits.maxTurnMs + EXEC_GRACE_MS,
    })) {
      switch (event.type) {
        case 'started':
          state.execRef = event.execRef;
          if (state.cancelRequested) {
            // The cancellation arrived between `subscribe` and the runner handing out a reference,
            // so there was nothing to signal then; this is the retry.
            beginCancellation(deps, input.handle, state);
          }
          break;
        case 'stdout':
          for (const parsed of parser.push(event.data)) {
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
    for (const parsed of parser.flush()) {
      await handleEvent(deps, input, state, parsed);
    }
  } catch (error) {
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
  } finally {
    if (state.killTimer !== undefined) {
      clearTimeout(state.killTimer);
    }
    await unsubscribe();
  }

  const reported = state.terminal;
  if (reported === 'completed' || reported === 'failed' || reported === 'cancelled') {
    return {
      terminal: reported,
      reportedByRuntime: true,
      exitCode: state.exitCode,
      ...(state.error === undefined ? {} : { error: state.error }),
      protocolErrors: state.protocolErrors,
    };
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
