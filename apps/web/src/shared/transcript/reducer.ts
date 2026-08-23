/**
 * Pure fold of `AgentEvent`s into a {@link TranscriptState}.
 *
 * Layer: shared (data model).
 *
 * No wall-clock reads happen here: every timestamp comes in through the action's `now` field so
 * the fold stays deterministic and trivially testable with a fake clock.
 */
import {
  agentEventSchema,
  isPrepareWarning,
  preparedNoticeText,
  pushedNoticeText,
} from '@agent-hangar/core';
import type { AgentEvent, AgentEventOf, AgentEventType } from '@agent-hangar/core';

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
import { prepareNoticeId, TOOL_OUTPUT_DISPLAY_LIMIT_BYTES, TURN_CANCELLED_NOTICE } from './types';

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
  // Ordered by the comparison itself rather than by an equality test in front of it: two ids that
  // sort the same way are the same id, and a separate test for that is a branch nothing could tell
  // apart from the one below it.
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
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
  // Stryker disable next-line ConditionalExpression: the kind narrows the type; ids are minted per
  // kind and no other item can carry a notice's, so the comparison beside it decides alone.
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
  // Stryker disable next-line ConditionalExpression: the kind is what gives `callId` a type here —
  // no other item has the field at all, so the comparison beside it already decides.
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
  // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: a budget of
  // zero produces an empty slice and an unchanged item by the same route; what this guard is for
  // is a negative one, which would slice from the end of the buffer instead of the start.
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
  // Sliced unconditionally: a slice longer than the text is the text, so a fast path for the
  // chunk that fits would be a branch producing what the cut already produces.
  const kept = decoder.decode(encoded.slice(0, budget), { stream: true });
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

/**
 * Opens the row for a tool call the model has just made.
 *
 * A reload rebuilds the running turn from what the database holds and then reopens the stream,
 * which replays that turn from its first event, so a call already on screen arrives again. It is
 * the same call: the worker stores the call id the runtime issued, so both roads carry one
 * identifier — the one {@link findTool} matches on for every later event of that call. The seeded
 * row is kept rather than replaced, because it carries the start time persistence recorded while
 * the event carries the moment of the reload.
 *
 * @param state - Current state.
 * @param event - The call the model made.
 * @param now - Clock of this action.
 * @returns The state with the call's row open.
 */
function openToolCall(
  state: TranscriptState,
  event: AgentEventOf<'tool.call'>,
  now: number,
): TranscriptState {
  const withFinalizedAssistant = finalizeStreamingAssistant(state.items);
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

/**
 * Records where the agent pushed.
 *
 * The same replay reaches here, and these two roads cannot agree on an id: the worker stores this
 * line as a `SYSTEM` message, so a reloaded transcript carries it under that message's own id
 * while the event would add it under the sha. What identifies a push is the fact it states — one
 * branch at one commit — and that is exactly what the line says, so a line already saying it is
 * this push. Matched here rather than inside {@link pushNotice}, because a repeated
 * `protocol.error` is a second malformed event and not a second report of one.
 *
 * @param state - Current state.
 * @param event - The push.
 * @returns The state with the push reported once.
 */
function recordPush(state: TranscriptState, event: AgentEventOf<'git.pushed'>): TranscriptState {
  const text = pushedNoticeText(event.branch, event.sha);
  // Stryker disable next-line ConditionalExpression: the kind narrows the type; only a notice
  // carries this text, so the comparison beside it already decides.
  if (state.items.some((item) => item.kind === 'notice' && item.text === text)) {
    return state;
  }
  return { ...state, items: pushNotice(state.items, `git-${event.sha}`, 'success', text) };
}

function reduceEvent(state: TranscriptState, event: AgentEvent, now: number): TranscriptState {
  switch (event.type) {
    case 'turn.started':
      // The turn is remembered for the preparation notice alone, which has to be keyed per turn:
      // see `prepareNoticeId`.
      return {
        ...state,
        phase: 'preparing',
        startedAt: Date.parse(event.at),
        turnId: event.turnId,
      };

    case 'prepare.progress':
      // A finding is not progress. Progress collapses onto one line and `prepare.done` replaces
      // that line with the success text, which is right for "Cloning…" and wrong for "the branch
      // diverged from its remote" — the second is still true when the turn ends, and folding it
      // into the collapsing line is what made it visible for the few milliseconds between the two
      // events. A finding gets a line of its own that nothing later writes over.
      //
      // Keyed on the finding itself, and upserted rather than pushed, for the reason `recordPush`
      // gives: a client that reconnects replays the turn from its first event, so the same finding
      // arrives again, and a repeat of one fact is not a second fact.
      return isPrepareWarning(event.message)
        ? {
            ...state,
            items: upsertNotice(
              state.items,
              `${prepareNoticeId(state.turnId)}-finding-${event.message}`,
              'warning',
              event.message,
            ),
          }
        : {
            ...state,
            items: upsertNotice(state.items, prepareNoticeId(state.turnId), 'info', event.message),
          };

    case 'prepare.done': {
      const durationMs = state.startedAt === null ? undefined : now - state.startedAt;
      const text = preparedNoticeText(event.branch, event.headSha);
      return {
        ...state,
        phase: 'running',
        items: upsertNotice(
          state.items,
          prepareNoticeId(state.turnId),
          'success',
          text,
          durationMs,
        ),
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

    case 'tool.call':
      return openToolCall(state, event, now);

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
        // A result whose call was never folded in. The stream is capped at `TURN_EVENTS_MAXLEN`,
        // so a chatty long-running call plus a reconnect can deliver the terminal event of a call
        // whose opening frame has already been trimmed away. The row still has to appear — the
        // call happened and its outcome is known — but everything the opening frame carried is
        // reported as not received rather than filled in with a guess. `startedAt` is the one
        // exception and it is not a guess: the result states how long the call took, so the
        // instant it began follows from the instant it ended.
        const created: ToolTranscriptItem = {
          kind: 'tool',
          id: `tool-${event.callId}`,
          callId: event.callId,
          name: null,
          args: undefined,
          seq: null,
          status: toolCallStatusOf(event.status),
          stdout: '',
          stderr: '',
          shownBytes: 0,
          totalBytes: event.bytes,
          exitCode: event.exitCode,
          durationMs: event.durationMs,
          startedAt: now - event.durationMs,
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

    case 'git.pushed':
      return recordPush(state, event);

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
      // The two null tests narrow the types for the comparison below them, and nothing more: an
      // id that is not there never sorts at or before one that is, so the comparison reaches the
      // same answer on its own.
      // Stryker disable next-line ConditionalExpression,LogicalOperator
      const isDuplicate =
        action.id !== null &&
        // Stryker disable next-line ConditionalExpression
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
