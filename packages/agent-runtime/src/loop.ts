/**
 * The model ↔ tools loop of one turn.
 *
 * Layer: domain.
 *
 * Every step streams the model, executes whatever tools it asked for, feeds the results back and
 * goes round again until the model stops asking. Three things bound it, because the model decides
 * how long it wants to keep going: a step count, a wall clock, and the operator's cancellation.
 * All three end the turn through the same event vocabulary, and nothing is ever emitted after a
 * terminal event.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { toolNameSchema } from '@agent-hangar/core';
import type {
  AgentEvent,
  AgentModelProvider,
  ConversationItem,
  ModelUsage,
  ToolDefinition,
  TurnRequest,
} from '@agent-hangar/core';

import { looksLikeGitPush, resolveGitHead } from './git-events.js';
import type { GitRunner } from './git.js';
import type { ToolExecutionResult, ToolExecutor } from './tools/index.js';
import { describeError } from './tools/result.js';

/** Model attempts per step: the first try plus three retries after a rate limit. */
const MAX_MODEL_ATTEMPTS = 4;

/** First backoff after a rate limit; each further retry doubles it. */
const RETRY_BASE_MS = 1000;

/** How often a turn that has produced nothing announces that it is still alive. */
const DEFAULT_HEARTBEAT_MS = 10_000;

/** Milliseconds in a minute, for the limit message. */
const MS_PER_MINUTE = 60_000;

/** Everything the loop needs for one turn. */
export interface LoopDeps {
  /** The validated request. */
  request: TurnRequest;
  /** Provider to stream from. */
  provider: AgentModelProvider;
  /** Executor for the model's tool calls. */
  tools: ToolExecutor;
  /** Tool definitions offered to the model. */
  toolDefinitions: readonly ToolDefinition[];
  /**
   * Publishes one protocol event.
   *
   * @param event - The event.
   */
  emit(event: AgentEvent): Promise<void>;
  /** When the last event was written, for the heartbeat. */
  lastEmittedAt(): number;
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Child environment, already scrubbed of the credentials. */
  childEnv: Record<string, string>;
  /** Git runner, used to read where a push landed. */
  git: GitRunner;
  /** Aborting ends the turn with `turn.cancelled`. */
  signal: AbortSignal;
  /** Clock; injectable so limit and duration behaviour is deterministic. */
  now?: () => number;
  /** Waits out a retry backoff, returning early when the turn is cancelled. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Heartbeat interval; defaults to ten seconds. */
  heartbeatMs?: number;
}

/** How the turn ended. */
export type LoopOutcome =
  { kind: 'completed' } | { kind: 'cancelled' } | { kind: 'failed'; code: string };

/** Mutable state carried across the steps of one turn. */
interface LoopState {
  items: ConversationItem[];
  usage: ModelUsage;
  seq: number;
  steps: number;
  finalMessage: string;
}

/** Clock captured at the start of the turn. */
interface LoopClock {
  now: () => number;
  startedAt: number;
}

/** One tool call the model asked for. */
interface RequestedToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/** What one model round-trip produced. */
type StepOutcome =
  | { kind: 'ok'; text: string; toolCalls: RequestedToolCall[]; usage: ModelUsage }
  | { kind: 'cancelled' }
  | { kind: 'failed'; code: string; message: string };

/** What one streaming attempt produced. */
type AttemptOutcome =
  | { kind: 'ok'; text: string; toolCalls: RequestedToolCall[]; usage: ModelUsage }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: string; message: string };

/**
 * Waits out a backoff, returning early when the turn is cancelled.
 *
 * @param ms - How long to wait.
 * @param signal - Cancellation.
 */
async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  await delay(ms, undefined, { signal }).catch(() => undefined);
}

/**
 * Emits an event without waiting for it.
 *
 * Tool output arrives on the child's stream and cannot pause for the pipe. Ordering still holds
 * because the writer serialises everything it is handed, and a failed write is swallowed here
 * because the awaited emits around it report the same broken pipe.
 *
 * @param deps - Loop dependencies.
 * @param event - The event.
 */
function emitDetached(deps: LoopDeps, event: AgentEvent): void {
  void deps.emit(event).catch(() => undefined);
}

/**
 * Decodes the arguments of a tool call.
 *
 * Invalid JSON is handed on rather than rejected here, so the model gets the same schema failure
 * it would get for any other bad argument list, in the same place.
 *
 * @param raw - Arguments exactly as the model produced them.
 * @returns The decoded value, or a wrapper the tool schemas will reject.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}

/**
 * Streams one model round-trip, collecting its text, tool calls and usage.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state, read for the conversation so far.
 * @returns What the round-trip produced.
 */
async function streamAttempt(deps: LoopDeps, state: LoopState): Promise<AttemptOutcome> {
  let text = '';
  const toolCalls: RequestedToolCall[] = [];
  let usage: ModelUsage | undefined;
  const stream = deps.provider.stream({
    model: deps.request.model,
    instructions: deps.request.instructions,
    // A copy, not the live array: the loop keeps appending to it while the provider streams, and
    // a provider that reads its input lazily would otherwise see items from a later step.
    items: [...state.items],
    tools: deps.toolDefinitions,
    signal: deps.signal,
  });
  for await (const event of stream) {
    switch (event.type) {
      case 'text.delta':
        text += event.text;
        await deps.emit({ type: 'assistant.delta', text: event.text });
        break;
      case 'text.done':
        // Authoritative: providers may coalesce or re-emit deltas.
        text = event.text;
        break;
      case 'tool_call':
        toolCalls.push({ callId: event.callId, name: event.name, arguments: event.arguments });
        break;
      case 'tool_call.arguments.delta':
        // Providers emit these for live UIs; the runtime waits for the complete call.
        break;
      case 'response.done':
        usage = event.usage;
        break;
      case 'error':
        return { kind: 'error', code: event.code, message: event.message };
    }
  }
  if (deps.signal.aborted) {
    return { kind: 'cancelled' };
  }
  if (usage === undefined) {
    return { kind: 'error', code: 'unknown', message: 'model stream ended without response.done' };
  }
  return { kind: 'ok', text, toolCalls, usage };
}

/**
 * Runs one model round-trip, retrying a rate limit with exponential backoff.
 *
 * A retry discards whatever the failed attempt produced and starts the step again, so a partially
 * streamed answer is never mixed with its replacement.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state.
 * @returns What the step produced.
 */
async function runModelStep(deps: LoopDeps, state: LoopState): Promise<StepOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  let attempt = 1;
  for (;;) {
    const outcome: AttemptOutcome = await streamAttempt(deps, state).catch((error: unknown) => ({
      kind: 'error',
      code: 'unknown',
      message: describeError(error),
    }));
    if (outcome.kind !== 'error') {
      return outcome;
    }
    if (outcome.code !== 'rate_limit' || attempt >= MAX_MODEL_ATTEMPTS) {
      return { kind: 'failed', code: outcome.code, message: outcome.message };
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), deps.signal);
    if (deps.signal.aborted) {
      return { kind: 'cancelled' };
    }
    attempt += 1;
  }
}

/**
 * Emits `git.pushed` when a shell command turned out to be a successful push.
 *
 * @param deps - Loop dependencies.
 * @param name - Tool that ran.
 * @param result - What it produced.
 */
async function maybeEmitGitPushed(
  deps: LoopDeps,
  name: string,
  result: ToolExecutionResult,
): Promise<void> {
  if (result.command === undefined || name !== 'run_shell') {
    return;
  }
  const pushed = looksLikeGitPush({
    command: result.command,
    output: result.output,
    exitCode: result.exitCode,
  });
  if (!pushed) {
    return;
  }
  const head = await resolveGitHead(deps.git, deps.workspaceRoot, deps.childEnv);
  if (head !== null) {
    await deps.emit({ type: 'git.pushed', ...head });
  }
}

/**
 * Runs one tool call and feeds its result back into the conversation.
 *
 * A name the protocol does not know produces no `tool.call`/`tool.result` pair: those events can
 * only carry a known tool, and a line the worker would reject as malformed is worse than none.
 * The model still receives the failure as a `tool_result` and can correct itself.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state, mutated with the call and its result.
 * @param call - The call the model asked for.
 * @param clock - Clock of this turn.
 */
async function runToolCall(
  deps: LoopDeps,
  state: LoopState,
  call: RequestedToolCall,
  clock: LoopClock,
): Promise<void> {
  const args = parseArguments(call.arguments);
  const known = toolNameSchema.safeParse(call.name);
  if (known.success) {
    state.seq += 1;
    await deps.emit({
      type: 'tool.call',
      callId: call.callId,
      name: known.data,
      args,
      seq: state.seq,
    });
  }
  const startedAt = clock.now();
  const result = await deps.tools.execute(call.name, args, {
    signal: deps.signal,
    onOutput: (stream, text) => {
      emitDetached(deps, { type: 'tool.output.delta', callId: call.callId, stream, text });
    },
  });
  if (known.success) {
    await deps.emit({
      type: 'tool.result',
      callId: call.callId,
      exitCode: result.exitCode,
      bytes: result.bytes,
      durationMs: Math.max(0, clock.now() - startedAt),
      status: result.status,
    });
  }
  state.items.push(
    { type: 'tool_call', callId: call.callId, name: call.name, arguments: call.arguments },
    { type: 'tool_result', callId: call.callId, output: result.output },
  );
  await maybeEmitGitPushed(deps, call.name, result);
}

/**
 * Runs the tool calls of one step, in order.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state.
 * @param calls - Calls the model asked for.
 * @param clock - Clock of this turn.
 * @returns `true` when the turn was cancelled part way through.
 */
async function runToolCalls(
  deps: LoopDeps,
  state: LoopState,
  calls: readonly RequestedToolCall[],
  clock: LoopClock,
): Promise<boolean> {
  for (const call of calls) {
    if (deps.signal.aborted) {
      return true;
    }
    await runToolCall(deps, state, call, clock);
  }
  return deps.signal.aborted;
}

/**
 * Ends the turn because a limit was reached, telling the model's reader what was achieved.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state.
 * @returns The completed outcome; a limit is not a failure.
 */
async function stopForLimit(deps: LoopDeps, state: LoopState): Promise<LoopOutcome> {
  const minutes = Math.round(deps.request.limits.maxTurnMs / MS_PER_MINUTE);
  const soFar = state.finalMessage === '' ? 'no final message' : state.finalMessage;
  const text = `Stopped after ${String(state.steps)} steps / ${String(minutes)} min (limit reached). Work so far: ${soFar}`;
  await deps.emit({ type: 'assistant.message', text });
  state.finalMessage = text;
  await deps.emit({
    type: 'turn.completed',
    usage: state.usage,
    steps: state.steps,
    finalMessage: text,
    stoppedBy: 'limit',
  });
  return { kind: 'completed' };
}

/**
 * Ends the turn because it was cancelled.
 *
 * @param deps - Loop dependencies.
 * @returns The cancelled outcome.
 */
async function cancelTurn(deps: LoopDeps): Promise<LoopOutcome> {
  await deps.emit({ type: 'turn.cancelled' });
  return { kind: 'cancelled' };
}

/**
 * Runs one step of the turn.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state.
 * @param clock - Clock of this turn.
 * @returns The outcome when the turn ended in this step, otherwise `null` to keep going.
 */
async function runStep(
  deps: LoopDeps,
  state: LoopState,
  clock: LoopClock,
): Promise<LoopOutcome | null> {
  const outcome = await runModelStep(deps, state);
  if (outcome.kind === 'cancelled') {
    return cancelTurn(deps);
  }
  if (outcome.kind === 'failed') {
    await deps.emit({
      type: 'turn.failed',
      error: { code: outcome.code, message: outcome.message },
    });
    return { kind: 'failed', code: outcome.code };
  }
  state.usage.inputTokens += outcome.usage.inputTokens;
  state.usage.outputTokens += outcome.usage.outputTokens;
  if (outcome.text !== '') {
    await deps.emit({ type: 'assistant.message', text: outcome.text });
    state.items.push({ role: 'assistant', content: outcome.text });
    state.finalMessage = outcome.text;
  }
  if (outcome.toolCalls.length === 0) {
    await deps.emit({
      type: 'turn.completed',
      usage: state.usage,
      steps: state.steps,
      finalMessage: state.finalMessage,
    });
    return { kind: 'completed' };
  }
  return (await runToolCalls(deps, state, outcome.toolCalls, clock)) ? cancelTurn(deps) : null;
}

/**
 * Runs steps until the model stops asking for tools, a limit is reached, or the turn is cancelled.
 *
 * @param deps - Loop dependencies.
 * @param state - Loop state.
 * @param clock - Clock of this turn.
 * @returns How the turn ended.
 */
async function runSteps(deps: LoopDeps, state: LoopState, clock: LoopClock): Promise<LoopOutcome> {
  const { maxSteps, maxTurnMs } = deps.request.limits;
  for (let step = 1; step <= maxSteps; step += 1) {
    if (deps.signal.aborted) {
      return cancelTurn(deps);
    }
    if (clock.now() - clock.startedAt >= maxTurnMs) {
      return stopForLimit(deps, state);
    }
    await deps.emit({ type: 'step.started', step });
    state.steps = step;
    const outcome = await runStep(deps, state, clock);
    if (outcome !== null) {
      return outcome;
    }
  }
  return stopForLimit(deps, state);
}

/**
 * Runs one turn to completion, cancellation or failure.
 *
 * @param deps - Everything the loop needs for this turn.
 * @returns How the turn ended.
 */
export async function runTurnLoop(deps: LoopDeps): Promise<LoopOutcome> {
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const state: LoopState = {
    items: [...deps.request.items],
    usage: { inputTokens: 0, outputTokens: 0 },
    seq: 0,
    steps: 0,
    finalMessage: '',
  };
  const heartbeat = setInterval(() => {
    if (now() - deps.lastEmittedAt() >= heartbeatMs) {
      emitDetached(deps, { type: 'heartbeat', at: new Date(now()).toISOString() });
    }
  }, heartbeatMs);
  try {
    return await runSteps(deps, state, { now, startedAt: now() });
  } finally {
    clearInterval(heartbeat);
  }
}
