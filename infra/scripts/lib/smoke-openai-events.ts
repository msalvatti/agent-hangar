/**
 * Decoding and aggregation of the real-model smoke check's event stream.
 *
 * Layer: utility (pure).
 *
 * Two jobs, both deliberately free of input and output: turning `text/event-stream` bytes into
 * agent events, and turning each event into at most one short log line while accumulating the
 * facts the check is asserting about (steps, tool calls with their exit codes, token usage).
 *
 * What is *not* printed is the point. `assistant.delta` and `tool.output.delta` arrive hundreds of
 * times per turn and carry free-form model and command output; printing them would bury the
 * evidence and would paste a whole transcript into wherever the operator sends this output. They
 * are counted instead. Everything that is printed is either machine-generated (names, counts,
 * statuses, git object names) or a bounded slice of text the server has already redacted twice —
 * once in the container by the runtime, once in the worker before it reaches Redis. Nothing here
 * redacts anything itself: a second, weaker copy of that rule is how the two drift apart.
 */
import { agentEventSchema } from '../../../packages/core/src/agent-protocol/schemas.js';
import type { AgentEvent, AgentEventOf } from '../../../packages/core/src/agent-protocol/types.js';

/** Frame separator of the `text/event-stream` wire format. */
const FRAME_SEPARATOR = '\n\n';

/** Field prefix carrying the event name. */
const EVENT_PREFIX = 'event: ';

/** Field prefix carrying the JSON payload. */
const DATA_PREFIX = 'data: ';

/**
 * Event name the server sends when the replay cache is gone.
 *
 * Spelt here rather than imported: the producing constant lives in the web app, which this
 * host-side script does not depend on, and the wire contract that both sides answer to is
 * `SseFrame` in `packages/core`, where the value is part of the `event` union.
 */
const EXPIRED_EVENT = 'expired';

/** Longest tool target echoed in a log line. */
const MAX_TARGET_LENGTH = 80;

/** Longest free-text message echoed in a log line. */
const MAX_MESSAGE_LENGTH = 120;

/** Characters of a git object name kept when one is printed. */
const SHORT_SHA_LENGTH = 7;

/** Characters of the final assistant message reported as evidence. */
export const FINAL_MESSAGE_PREVIEW_LENGTH = 300;

/** Outcome events after which no more arrive. */
export type TerminalOutcome = 'completed' | 'failed' | 'cancelled';

/** One frame lifted off the wire. */
export type DecodedFrame =
  /** A frame carrying an event this build understands. */
  | { kind: 'event'; event: AgentEvent }
  /** The server said the replay cache is gone, so the transcript cannot be trusted. */
  | { kind: 'expired' }
  /** A frame whose payload did not satisfy the agent-event schema. */
  | { kind: 'undecodable'; name: string };

/** Feeds stream chunks in and gets whole frames out. */
export interface FrameDecoder {
  /**
   * Appends one chunk of the response body and returns every frame it completed.
   *
   * @param chunk - Decoded text, which may end mid-frame.
   * @returns The frames that are now complete, in arrival order.
   */
  push: (chunk: string) => DecodedFrame[];
}

/** One tool call and, once it arrives, its result. */
export interface ToolCallRecord {
  /** Position of the call within the turn, as the runtime numbered it. */
  seq: number;
  /** Tool the model invoked. */
  name: string;
  /**
   * The call's path or command, whole; empty when the arguments carried neither.
   *
   * Kept untruncated because it is evidence as well as display: the assertions read it, and a
   * shortened command would make what the turn actually ran unanswerable past the first line.
   */
  target: string;
  /** Result status, or `null` while the call is still running. */
  status: string | null;
  /** Process exit code, `null` for a tool that is not a process or has not finished. */
  exitCode: number | null;
  /** Bytes the tool produced, or `null` while it is still running. */
  bytes: number | null;
}

/** Everything the check learned from one turn's events. */
export interface SmokeObservation {
  /** Highest step number reached. */
  steps: number;
  /** Total characters of streamed assistant text. */
  assistantChars: number;
  /** Every tool call, in arrival order. */
  toolCalls: ToolCallRecord[];
  /** Token usage as reported by `turn.completed`, or `null` when the turn did not complete. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Final assistant message, as the server redacted it. */
  finalMessage: string;
  /** Branch and commit of a push, when the turn pushed one. */
  pushed: { branch: string; sha: string } | null;
  /** Which terminal event arrived, or `null` when none did. */
  terminal: TerminalOutcome | null;
  /** Reported reason of a `turn.failed`, or the empty string. */
  failure: string;
}

/** Accumulates {@link SmokeObservation} while formatting one log line per interesting event. */
export interface EventRecorder {
  /** The facts gathered so far; mutated as events arrive. */
  readonly observation: SmokeObservation;
  /**
   * Records one event.
   *
   * @param event - The event as decoded from the stream.
   * @returns The line to print, or `null` for an event that is only counted.
   */
  record: (event: AgentEvent) => string | null;
}

/**
 * Shortens text to a maximum length, marking that it was cut.
 *
 * @param text - Text to shorten.
 * @param max - Maximum number of characters to keep.
 * @returns The text, with an ellipsis when it was longer than `max`.
 */
function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Keeps the readable prefix of a git object name.
 *
 * @param sha - Full object name.
 * @returns Its first {@link SHORT_SHA_LENGTH} characters.
 */
function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * Parses JSON without throwing.
 *
 * @param raw - The `data:` field of one frame.
 * @returns The parsed value, or `undefined` when the text is not JSON.
 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed frame is data, not a fault: `undefined` fails the schema check like any other
    // invalid payload and is reported as one unreadable frame.
    return undefined;
  }
}

/**
 * Decodes one complete frame block.
 *
 * @param block - The frame's text, without its trailing blank line.
 * @returns The frame, or `null` for a heartbeat comment or a block naming no event.
 */
function decodeFrame(block: string): DecodedFrame | null {
  let name = '';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith(EVENT_PREFIX)) {
      name = line.slice(EVENT_PREFIX.length);
    } else if (line.startsWith(DATA_PREFIX)) {
      data = line.slice(DATA_PREFIX.length);
    }
  }
  if (name === '') {
    return null;
  }
  if (name === EXPIRED_EVENT) {
    return { kind: 'expired' };
  }
  const parsed = agentEventSchema.safeParse(parseJson(data));
  return parsed.success ? { kind: 'event', event: parsed.data } : { kind: 'undecodable', name };
}

/**
 * Creates a decoder that reassembles frames across chunk boundaries.
 *
 * The server writes each frame in one `enqueue`, but a chunk the client reads is whatever the
 * transport handed it: a frame can arrive split anywhere, and two can arrive together. The
 * decoder therefore holds the remainder rather than assuming a chunk is a frame.
 *
 * @returns A decoder over one response body.
 */
export function createFrameDecoder(): FrameDecoder {
  let buffer = '';
  return {
    push(chunk: string): DecodedFrame[] {
      buffer += chunk;
      const frames: DecodedFrame[] = [];
      let index = buffer.indexOf(FRAME_SEPARATOR);
      while (index !== -1) {
        const decoded = decodeFrame(buffer.slice(0, index));
        buffer = buffer.slice(index + FRAME_SEPARATOR.length);
        if (decoded !== null) {
          frames.push(decoded);
        }
        index = buffer.indexOf(FRAME_SEPARATOR);
      }
      return frames;
    },
  };
}

/**
 * Reads a string property off a tool call's arguments, which the model produced and which the
 * protocol therefore types as `unknown`.
 *
 * @param args - The `args` field of a `tool.call` event.
 * @param key - Property to read.
 * @returns The value when it is a string, otherwise `undefined`.
 */
function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Describes what a tool call acts on.
 *
 * @param args - The `args` field of a `tool.call` event.
 * @returns The call's path or command, or the empty string when it carried neither.
 */
function callTarget(args: unknown): string {
  return stringArgument(args, 'path') ?? stringArgument(args, 'command') ?? '';
}

/** The empty observation every recorder starts from. */
function emptyObservation(): SmokeObservation {
  return {
    steps: 0,
    assistantChars: 0,
    toolCalls: [],
    usage: null,
    finalMessage: '',
    pushed: null,
    terminal: null,
    failure: '',
  };
}

/**
 * Formats the token counts of a completed turn.
 *
 * @param usage - Usage as reported by `turn.completed`.
 * @returns `<input>/<output>`.
 */
export function formatTokens(usage: { inputTokens: number; outputTokens: number } | null): string {
  return usage === null ? 'n/a' : `${usage.inputTokens}/${usage.outputTokens}`;
}

/**
 * Creates a recorder over one turn.
 *
 * @returns The recorder and the observation it fills in.
 */
/** The mutable state one recorder keeps while a turn streams. */
interface RecorderState {
  /** Facts the check later asserts on. */
  observation: SmokeObservation;
  /** Calls whose result has not arrived, keyed by the model's call id. */
  pending: Map<string, ToolCallRecord>;
}

/**
 * Records a tool call and names it.
 *
 * @param state - Recorder state.
 * @param event - The call as the runtime reported it.
 * @returns The line to print.
 */
function onToolCall(state: RecorderState, event: AgentEventOf<'tool.call'>): string {
  const target = callTarget(event.args);
  const record: ToolCallRecord = {
    seq: event.seq,
    name: event.name,
    target,
    status: null,
    exitCode: null,
    bytes: null,
  };
  state.pending.set(event.callId, record);
  state.observation.toolCalls.push(record);
  // `list_dir` at the workspace root carries a null path, which is a real call with nothing to
  // name; a trailing space would read as a lost argument rather than an absent one.
  return target === ''
    ? `tool.call ${event.name}`
    : `tool.call ${event.name} ${truncate(target, MAX_TARGET_LENGTH)}`;
}

/**
 * Completes a recorded call with its result, and names it.
 *
 * A result whose call was never seen — a stream resumed past the call — still prints, naming the
 * tool as unknown: an exit code is worth reporting even when what produced it is not known.
 *
 * @param state - Recorder state.
 * @param event - The result as the runtime reported it.
 * @returns The line to print.
 */
function onToolResult(state: RecorderState, event: AgentEventOf<'tool.result'>): string {
  const record = state.pending.get(event.callId);
  if (record !== undefined) {
    record.status = event.status;
    record.exitCode = event.exitCode;
    record.bytes = event.bytes;
  }
  const name = record?.name ?? 'unknown';
  const exit = event.exitCode ?? 'n/a';
  return `tool.result ${name} ${event.status} exit=${exit} bytes=${event.bytes} ${event.durationMs}ms`;
}

/**
 * Records the completion of a turn and names it.
 *
 * `steps` is taken as the larger of what the step events showed and what the completion states, so
 * a stream resumed past the early steps still reports the whole turn.
 *
 * @param state - Recorder state.
 * @param event - The completion as the runtime reported it.
 * @returns The line to print.
 */
function onCompleted(state: RecorderState, event: AgentEventOf<'turn.completed'>): string {
  state.observation.terminal = 'completed';
  state.observation.usage = event.usage;
  state.observation.steps = Math.max(state.observation.steps, event.steps);
  state.observation.finalMessage = event.finalMessage;
  const limit = event.stoppedBy === undefined ? '' : ' stoppedBy=limit';
  return `turn.completed steps=${event.steps} tokens=${formatTokens(event.usage)}${limit}`;
}

/**
 * Records one event and produces its line.
 *
 * The switch is exhaustive over the protocol, listed variant by variant rather than defaulted, so
 * a new event has to be given a place here instead of silently vanishing from the report.
 *
 * @param state - Recorder state.
 * @param event - The event as decoded from the stream.
 * @returns The line to print, or `null` for an event that is only counted.
 */
function recordEvent(state: RecorderState, event: AgentEvent): string | null {
  const { observation } = state;
  switch (event.type) {
    case 'turn.started':
      return `turn.started ${event.turnId}`;
    case 'prepare.progress':
      return `prepare ${truncate(event.message, MAX_MESSAGE_LENGTH)}`;
    case 'prepare.done':
      return `prepare.done branch=${event.branch} sha=${shortSha(event.headSha)}`;
    case 'step.started':
      observation.steps = Math.max(observation.steps, event.step);
      return `step ${event.step}`;
    case 'assistant.delta':
      observation.assistantChars += event.text.length;
      return null;
    case 'assistant.message':
      return `assistant.message ${event.text.length} chars`;
    case 'tool.call':
      return onToolCall(state, event);
    case 'tool.output.delta':
      return null;
    case 'tool.result':
      return onToolResult(state, event);
    case 'git.pushed':
      observation.pushed = { branch: event.branch, sha: event.sha };
      return `git.pushed ${event.branch} ${shortSha(event.sha)}`;
    case 'heartbeat':
      return null;
    case 'turn.completed':
      return onCompleted(state, event);
    case 'turn.failed':
      observation.terminal = 'failed';
      observation.failure = `${event.error.code}: ${truncate(event.error.message, MAX_MESSAGE_LENGTH)}`;
      return `turn.failed ${observation.failure}`;
    case 'turn.cancelled':
      observation.terminal = 'cancelled';
      return 'turn.cancelled';
    case 'protocol.error':
      return `protocol.error ${event.reason} length=${event.length}`;
  }
}

/**
 * Creates a recorder over one turn.
 *
 * @returns The recorder and the observation it fills in.
 */
export function createEventRecorder(): EventRecorder {
  const state: RecorderState = { observation: emptyObservation(), pending: new Map() };
  return {
    observation: state.observation,
    record: (event) => recordEvent(state, event),
  };
}
