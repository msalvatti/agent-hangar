/**
 * Pure fold of `AgentEvent`s into a {@link TranscriptState}.
 *
 * Layer: shared (data model).
 *
 * No wall-clock reads happen here: every timestamp comes in through the action's `now` field so
 * the fold stays deterministic and trivially testable with a fake clock.
 */
import { agentEventSchema, pushedNoticeText, shortSha } from '@agent-hangar/core';
import type { AgentEvent, AgentEventType } from '@agent-hangar/core';

import { utf8ByteLength } from './lib/format';
import type {
  AssistantTranscriptItem,
  NoticeTone,
  NoticeTranscriptItem,
  ToolCallStatus,
  ToolTranscriptItem,
  TranscriptAction,
  TranscriptItem,
  TranscriptState,
} from './types';
import { PREPARE_NOTICE_ID, TOOL_OUTPUT_DISPLAY_LIMIT_BYTES, TURN_CANCELLED_NOTICE } from './types';

/** Discriminator values of every `AgentEvent` variant, derived from the Zod schema itself. */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = agentEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** Whether a {@link TranscriptState.phase} will not change without a new turn. */
export function isTerminalPhase(phase: TranscriptState['phase']): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
}

const STREAM_ID_PATTERN = /^(\d+)-(\d+)$/;

/**
 * Orders two Redis stream ids (`<milliseconds>-<sequence>`) numerically, falling back to a plain
 * string comparison when either id does not match that shape.
 *
 * @param a - First id.
 * @param b - Second id.
 * @returns Negative when `a` sorts before `b`, positive when after, zero when equal.
 */
export function compareStreamIds(a: string, b: string): number {
  const parsedA = STREAM_ID_PATTERN.exec(a);
  const parsedB = STREAM_ID_PATTERN.exec(b);
  if (parsedA !== null && parsedB !== null) {
    const msA = Number(parsedA[1]);
    const msB = Number(parsedB[1]);
    if (msA !== msB) {
      return msA - msB;
    }
    return Number(parsedA[2]) - Number(parsedB[2]);
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function lastItem(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  return items[items.length - 1];
}

/** Marks the trailing streaming assistant item (if any) as finalized, text unchanged. */
function finalizeStreamingAssistant(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  const last = lastItem(items);
  if (last?.kind !== 'assistant' || !last.streaming) {
    return items;
  }
  const finalized: AssistantTranscriptItem = { ...last, streaming: false };
  return [...items.slice(0, -1), finalized];
}

function upsertNotice(
  items: readonly TranscriptItem[],
  id: string,
  tone: NoticeTone,
  text: string,
  durationMs?: number,
): readonly TranscriptItem[] {
  const notice: NoticeTranscriptItem = {
    kind: 'notice',
    id,
    tone,
    text,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  const index = items.findIndex((item) => item.kind === 'notice' && item.id === id);
  if (index === -1) {
    return [...items, notice];
  }
  return [...items.slice(0, index), notice, ...items.slice(index + 1)];
}

function pushNotice(
  items: readonly TranscriptItem[],
  id: string,
  tone: NoticeTone,
  text: string,
): readonly TranscriptItem[] {
  return [...items, { kind: 'notice', id, tone, text }];
}

/**
 * Locates the tool item for a callId. The predicate already guarantees `kind === 'tool'` for any
 * match, so the cast is a type-level formality (there is no runtime branch left to miss).
 */
function findTool(
  items: readonly TranscriptItem[],
  callId: string,
): { index: number; item: ToolTranscriptItem } | null {
  const index = items.findIndex((item) => item.kind === 'tool' && item.callId === callId);
  if (index === -1) {
    return null;
  }
  return { index, item: items[index] as ToolTranscriptItem };
}

/**
 * Appends a delta to a tool item's stdout/stderr, truncating so the item's `shownBytes` never
 * exceeds {@link TOOL_OUTPUT_DISPLAY_LIMIT_BYTES}.
 */
function appendToolOutput(
  item: ToolTranscriptItem,
  stream: 'stdout' | 'stderr',
  text: string,
): ToolTranscriptItem {
  const budget = TOOL_OUTPUT_DISPLAY_LIMIT_BYTES - item.shownBytes;
  if (budget <= 0) {
    return item;
  }
  const encoder = new TextEncoder();
  // Streaming mode: cutting the encoded text at a byte boundary can split a multibyte character,
  // and a one-shot decode would turn that partial sequence into U+FFFD — three bytes, more than
  // the fragment it replaced, pushing the item past the display cap. A streaming decoder holds an
  // incomplete trailing sequence back instead of substituting it, and it is never flushed.
  const decoder = new TextDecoder();
  const encoded = encoder.encode(text);
  const kept =
    encoded.length <= budget ? text : decoder.decode(encoded.slice(0, budget), { stream: true });
  const keptBytes = utf8ByteLength(kept);
  return {
    ...item,
    [stream]: item[stream] + kept,
    shownBytes: item.shownBytes + keptBytes,
  };
}

function replaceAt<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

/** Maps the runtime's tool result status onto the display status vocabulary. */
function toolCallStatusOf(status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'): ToolCallStatus {
  switch (status) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    case 'TIMED_OUT':
      return 'timed_out';
  }
}

function reduceEvent(state: TranscriptState, event: AgentEvent, now: number): TranscriptState {
  switch (event.type) {
    case 'turn.started':
      return { ...state, phase: 'preparing', startedAt: Date.parse(event.at) };

    case 'prepare.progress':
      return {
        ...state,
        items: upsertNotice(state.items, PREPARE_NOTICE_ID, 'info', event.message),
      };

    case 'prepare.done': {
      const durationMs = state.startedAt === null ? undefined : now - state.startedAt;
      const text = `Prepared ${event.branch} at ${shortSha(event.headSha)}`;
      return {
        ...state,
        phase: 'running',
        items: upsertNotice(state.items, PREPARE_NOTICE_ID, 'success', text, durationMs),
      };
    }

    case 'step.started':
      return { ...state, step: event.step };

    case 'assistant.delta': {
      const last = lastItem(state.items);
      if (last?.kind === 'assistant' && last.streaming) {
        const updated: AssistantTranscriptItem = { ...last, text: last.text + event.text };
        return {
          ...state,
          phase: 'running',
          items: replaceAt(state.items, state.items.length - 1, updated),
        };
      }
      const created: AssistantTranscriptItem = {
        kind: 'assistant',
        id: `assistant-${state.step}-${state.items.length}`,
        text: event.text,
        streaming: true,
      };
      return { ...state, phase: 'running', items: [...state.items, created] };
    }

    case 'assistant.message': {
      const last = lastItem(state.items);
      if (last?.kind === 'assistant' && last.streaming) {
        const updated: AssistantTranscriptItem = { ...last, text: event.text, streaming: false };
        return { ...state, items: replaceAt(state.items, state.items.length - 1, updated) };
      }
      const created: AssistantTranscriptItem = {
        kind: 'assistant',
        id: `assistant-${state.step}-${state.items.length}`,
        text: event.text,
        streaming: false,
      };
      return { ...state, items: [...state.items, created] };
    }

    case 'tool.call': {
      const withFinalizedAssistant = finalizeStreamingAssistant(state.items);
      // A reload rebuilds the running turn from what the database holds and then reopens the
      // stream, which replays that turn from its first event, so a call already on screen arrives
      // again. It is the same call: the worker stores the call id the runtime issued, so both
      // roads carry one identifier — the one `tool.result` and `tool.output.delta` below already
      // find their row by. The seeded row is kept rather than replaced, because it carries the
      // start time persistence recorded and this event carries the moment of the reload.
      if (findTool(withFinalizedAssistant, event.callId) !== null) {
        return { ...state, items: withFinalizedAssistant };
      }
      const created: ToolTranscriptItem = {
        kind: 'tool',
        id: `tool-${event.callId}`,
        callId: event.callId,
        name: event.name,
        args: event.args,
        seq: event.seq,
        status: 'running',
        stdout: '',
        stderr: '',
        shownBytes: 0,
        totalBytes: null,
        exitCode: null,
        durationMs: null,
        startedAt: now,
      };
      return { ...state, items: [...withFinalizedAssistant, created] };
    }

    case 'tool.output.delta': {
      const found = findTool(state.items, event.callId);
      if (found === null) {
        return state;
      }
      const updated = appendToolOutput(found.item, event.stream, event.text);
      return { ...state, items: replaceAt(state.items, found.index, updated) };
    }

    case 'tool.result': {
      const found = findTool(state.items, event.callId);
      if (found === null) {
        const created: ToolTranscriptItem = {
          kind: 'tool',
          id: `tool-${event.callId}`,
          callId: event.callId,
          name: 'run_shell',
          args: {},
          seq: 0,
          status: toolCallStatusOf(event.status),
          stdout: '',
          stderr: '',
          shownBytes: 0,
          totalBytes: event.bytes,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          startedAt: now,
        };
        return { ...state, items: [...state.items, created] };
      }
      const updated: ToolTranscriptItem = {
        ...found.item,
        status: toolCallStatusOf(event.status),
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        totalBytes: event.bytes,
      };
      return { ...state, items: replaceAt(state.items, found.index, updated) };
    }

    case 'git.pushed': {
      const text = pushedNoticeText(event.branch, event.sha);
      // Same replay, and here the two roads cannot agree on an id: the worker stores this line as
      // a `SYSTEM` message, so a reloaded transcript carries it under that message's own id while
      // this event would add it under the sha. What identifies a push is the fact it states — one
      // branch at one commit — and that is exactly what the line says, so a line already saying it
      // is this push. Matched on the notice text alone rather than in `pushNotice`, because a
      // repeated `protocol.error` is a second malformed event and not a second report of one.
      if (state.items.some((item) => item.kind === 'notice' && item.text === text)) {
        return state;
      }
      return { ...state, items: pushNotice(state.items, `git-${event.sha}`, 'success', text) };
    }

    case 'heartbeat':
      return state;

    case 'turn.completed': {
      const finalizedItems = finalizeStreamingAssistant(state.items);
      const hasFinalMessage =
        event.finalMessage.length > 0 &&
        !finalizedItems.some(
          (item) => item.kind === 'assistant' && item.text === event.finalMessage,
        );
      const withFinalMessage = hasFinalMessage
        ? [
            ...finalizedItems,
            {
              kind: 'assistant',
              id: `assistant-${state.step}-${finalizedItems.length}`,
              text: event.finalMessage,
              streaming: false,
            } satisfies AssistantTranscriptItem,
          ]
        : finalizedItems;
      const withStopNotice =
        event.stoppedBy === 'limit'
          ? pushNotice(
              withFinalMessage,
              `limit-${state.step}`,
              'warning',
              'Stopped early: step or time limit reached.',
            )
          : withFinalMessage;
      return {
        ...state,
        phase: 'succeeded',
        finishedAt: now,
        usage: event.usage,
        stoppedBy: event.stoppedBy ?? null,
        items: withStopNotice,
      };
    }

    case 'turn.failed': {
      const errorItem: TranscriptItem = {
        kind: 'error',
        id: `error-${state.step}`,
        code: event.error.code,
        message: event.error.message,
      };
      return {
        ...state,
        phase: 'failed',
        finishedAt: now,
        error: event.error,
        items: [...finalizeStreamingAssistant(state.items), errorItem],
      };
    }

    case 'turn.cancelled':
      return {
        ...state,
        phase: 'cancelled',
        finishedAt: now,
        items: pushNotice(
          finalizeStreamingAssistant(state.items),
          `cancel-${state.step}`,
          'warning',
          TURN_CANCELLED_NOTICE,
        ),
      };

    case 'protocol.error':
      return {
        ...state,
        items: pushNotice(
          state.items,
          `protocol-error-${state.items.length}`,
          'warning',
          'Malformed event skipped.',
        ),
      };
  }
}

/**
 * Folds one {@link TranscriptAction} into a {@link TranscriptState}. Pure and side-effect free;
 * every timestamp the result needs comes from `action.now`.
 *
 * @param state - Current state.
 * @param action - Action to apply.
 * @returns The next state (a new object; `state` is never mutated).
 */
export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case 'event': {
      const isDuplicate =
        action.id !== null &&
        state.lastEventId !== null &&
        compareStreamIds(action.id, state.lastEventId) <= 0;
      if (isDuplicate) {
        return state;
      }
      const advanced: TranscriptState = {
        ...state,
        lastEventId: action.id ?? state.lastEventId,
        lastActivityAt: action.now,
      };
      return reduceEvent(advanced, action.event, action.now);
    }
    case 'connection':
      return { ...state, connection: action.connection };
    case 'reset':
      return {
        ...state,
        items: action.items,
        phase: action.phase,
        error: null,
        usage: null,
        stoppedBy: null,
      };
  }
}
