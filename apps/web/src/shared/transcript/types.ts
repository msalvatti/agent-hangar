/**
 * Domain-free data model of a rendered turn transcript.
 *
 * Layer: shared (data model).
 *
 * A transcript is the fold of the agent runtime's event stream (`AgentEvent`, see
 * `@agent-hangar/core`) into a list of displayable items plus turn-level state. Nothing here
 * knows about chats or scheduled runs — both features build on the same model.
 */
import type { AgentEvent, ToolName } from '@agent-hangar/core';

/** A message from the human operator. */
export interface UserTranscriptItem {
  kind: 'user';
  id: string;
  text: string;
  at?: string;
}

/** Assistant prose, either still streaming or finalized. */
export interface AssistantTranscriptItem {
  kind: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
  at?: string;
}

/** Lifecycle of one tool invocation. */
export type ToolCallStatus = 'running' | 'succeeded' | 'failed' | 'timed_out';

/** One `run_shell` / `read_file` / `write_file` / `list_dir` invocation and its output. */
export interface ToolTranscriptItem {
  kind: 'tool';
  id: string;
  callId: string;
  /**
   * Tool the model called, or `null` when this reader cannot name it.
   *
   * `null` is not a defect and not a default: it is the row declining to guess. A row can be
   * opened by a later event of a call whose opening frame this client never received, and a
   * persisted row can name a tool this build does not know. Both are states the row reports as
   * themselves — naming a tool it has no evidence for would put a plausible lie on screen, which
   * is worse than an honest blank, because the reader has no way to tell the two apart.
   */
  name: ToolName | null;
  /**
   * Arguments as the model sent them, or `undefined` when they never reached this reader.
   *
   * `undefined` and `{}` are different facts — "not received" and "the model sent no arguments" —
   * and a row that renders the first as the second is asserting something nobody measured.
   */
  args: unknown;
  /** Position of the call within its turn, or `null` when the opening frame was not seen. */
  seq: number | null;
  status: ToolCallStatus;
  stdout: string;
  stderr: string;
  shownBytes: number;
  totalBytes: number | null;
  exitCode: number | null;
  durationMs: number | null;
  startedAt: number;
}

/** Tone of a {@link NoticeTranscriptItem}. */
export type NoticeTone = 'info' | 'warning' | 'success';

/** A short, centred, non-bubble line: prepare progress, pushes, cancellation, limits. */
export interface NoticeTranscriptItem {
  kind: 'notice';
  id: string;
  tone: NoticeTone;
  text: string;
  durationMs?: number;
}

/** A turn failure rendered inline. */
export interface ErrorTranscriptItem {
  kind: 'error';
  id: string;
  code: string;
  message: string;
  /**
   * Turn the failure belongs to, when the reader knows it.
   *
   * A transcript can hold the failures of several turns at once, and only one of them — the
   * chat's newest — is a turn anything can still be done about. A caller that offers an action
   * per failure needs to know which row it may offer it on; `undefined` means the row came from
   * the live stream, which follows exactly one turn and so is always that one.
   */
  turnId?: string;
}

/** Every row a {@link Transcript} can render, discriminated by `kind`. */
export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | NoticeTranscriptItem
  | ErrorTranscriptItem;

/** Lifecycle of the turn the transcript represents. */
export type TurnPhase =
  'idle' | 'queued' | 'preparing' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** State of the SSE connection feeding the transcript. */
export type ConnectionState =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'expired' | 'closed';

/** Token usage of a finished turn. */
export interface TranscriptUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Why a turn stopped before the model chose to finish. */
export type TranscriptStopReason = 'limit';

/** Error carried by a failed turn. */
export interface TranscriptError {
  code: string;
  message: string;
}

/** The full state a {@link Transcript} renders. */
export interface TranscriptState {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  startedAt: number | null;
  finishedAt: number | null;
  step: number;
  usage: TranscriptUsage | null;
  stoppedBy: TranscriptStopReason | null;
  error: TranscriptError | null;
  connection: ConnectionState;
  lastEventId: string | null;
  lastActivityAt: number | null;
}

/** Action folded into a {@link TranscriptState} by {@link transcriptReducer}. */
export type TranscriptAction =
  | { type: 'event'; event: AgentEvent; id: string | null; now: number }
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'reset'; items: readonly TranscriptItem[]; phase: TurnPhase };

/**
 * Bytes of tool output shown in the transcript before it is capped. The runtime still enforces
 * `maxToolOutputBytes` (spec 03) on what the model sees; this is the smaller display budget so a
 * chatty command cannot make one row dominate the page (spec 10 §4.2).
 */
export const TOOL_OUTPUT_DISPLAY_LIMIT_BYTES = 8 * 1024;

/**
 * How long the SSE hook tolerates no activity while a turn is preparing or running before it
 * reopens the connection. Three times the 15 s server heartbeat (spec 03 §4).
 */
export const STALL_TIMEOUT_MS = 45_000;

/** Stable id of the single notice item that tracks workspace preparation progress. */
export const PREPARE_NOTICE_ID = 'prepare';

/**
 * Line shown when a turn was stopped by the operator. Written once so the notice the live stream
 * pushes and the one a reloaded chat rebuilds from `Turn.status` read the same.
 */
export const TURN_CANCELLED_NOTICE = 'Turn cancelled.';

/** Fields a caller may seed on {@link createInitialState}. */
export type InitialStateOverrides = Partial<
  Pick<TranscriptState, 'items' | 'phase' | 'lastEventId'>
>;

/**
 * Builds an empty transcript state, optionally pre-seeded from persisted history.
 *
 * @param partial - `items`, `phase` and/or `lastEventId` to seed instead of the defaults.
 * @returns A fresh {@link TranscriptState}.
 */
export function createInitialState(partial: InitialStateOverrides = {}): TranscriptState {
  return {
    items: partial.items ?? [],
    phase: partial.phase ?? 'idle',
    startedAt: null,
    finishedAt: null,
    step: 0,
    usage: null,
    stoppedBy: null,
    error: null,
    connection: 'idle',
    lastEventId: partial.lastEventId ?? null,
    lastActivityAt: null,
  };
}
