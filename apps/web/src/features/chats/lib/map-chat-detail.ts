/**
 * Turns the persisted chat detail into the transcript model the shared renderer consumes.
 *
 * Layer: feature (lib).
 *
 * The API returns messages, turns and tool-call logs as three lists; the transcript is one ordered
 * list. A prompt written from now on names the turn that answers it, but that is not enough to
 * merge on: every user message stored before the routes started passing the id still has a null
 * `turnId`, and the rows a turn produces have no key back to the prompt either. What all three
 * lists do carry is when each row happened, and the order they happened in is the order the
 * transcript reads in: a tool call starts after the prompt that triggered it and before the answer
 * that follows it, and a turn finishes after the last call it made. So the lists are merged on
 * their own timestamps, which is right for the whole history rather than only for its newest part.
 */
import { systemNoticeTone, toolNameSchema } from '@agent-hangar/core';
import type { ChatDetail, MessageView, ToolCallView, ToolName, TurnView } from '@agent-hangar/core';

import { TURN_CANCELLED_NOTICE, utf8ByteLength } from '@/shared/transcript';
import type { ToolCallStatus, TranscriptItem, TurnPhase } from '@/shared/transcript';

/** Code every rebuilt failure row carries; the persisted turn keeps the message, not a code. */
const TURN_FAILED_CODE = 'TURN_FAILED';

/** Turn status as persisted, mapped onto the transcript's phase. */
const PHASE_BY_TURN_STATUS: Readonly<Record<TurnView['status'], TurnPhase>> = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** Tool-call status as persisted, mapped onto the transcript's status. */
const TOOL_STATUS: Readonly<Record<ToolCallView['status'], ToolCallStatus>> = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
};

/**
 * Tools whose output the agent runtime streams as it is produced.
 *
 * Every other tool hands back one block of text, and the runtime routes that block by outcome:
 * stdout when the call succeeded, stderr when it did not, because the text is then the reason it
 * did not work (`packages/agent-runtime/src/loop.ts`, the branch that emits a `tool.output.delta`
 * for a tool that never used the streaming hook). A persisted row keeps the text and not the
 * stream it was written to, so the reload path re-derives it from the same two facts — which is
 * exact for these tools and only for these: a `run_shell` result interleaves both streams and no
 * rule can split it back apart.
 */
const STREAMING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['run_shell']);

/** Phases in which the turn is still producing events, so the stream stays open. */
const LIVE_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>(['queued', 'preparing', 'running']);

/** The transcript model rebuilt from a persisted chat. */
export interface MappedChat {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  /** Turn to subscribe to, or `null` when the newest turn has already finished. */
  activeTurnId: string | null;
  startedAt: number | null;
  /** Newest user prompt, so a failed turn can be retried with it. */
  lastPrompt: string | null;
}

/** A transcript item and the instant it belongs at, before the lists are merged. */
interface TimedItem {
  at: number;
  item: TranscriptItem;
}

/**
 * Converts one persisted message into a transcript item.
 *
 * `TOOL_SUMMARY` rows exist only to compact the model's context and are never displayed.
 *
 * @param message - The persisted message.
 * @returns The item, or `null` when the role is not displayed.
 */
function toMessageItem(message: MessageView): TranscriptItem | null {
  switch (message.role) {
    case 'USER':
      return { kind: 'user', id: message.id, text: message.content, at: message.createdAt };
    case 'ASSISTANT':
      return {
        kind: 'assistant',
        id: message.id,
        text: message.content,
        streaming: false,
        at: message.createdAt,
      };
    case 'SYSTEM':
      return {
        kind: 'notice',
        id: message.id,
        tone: systemNoticeTone(message.content),
        text: message.content,
      };
    case 'TOOL_SUMMARY':
      return null;
  }
}

/**
 * Converts one persisted tool-call log into a transcript item.
 *
 * @param call - The persisted log row.
 * @returns The tool item.
 */
function toToolItem(call: ToolCallView): TranscriptItem {
  const parsed = toolNameSchema.safeParse(call.toolName);
  // The contract types `toolName` as a free string, so a build that does not know the tool says
  // so. Falling back to a real tool name would make the row read as a call the model never made.
  const name: ToolName | null = parsed.success ? parsed.data : null;
  const head = call.resultHead ?? '';
  const failed = call.status === 'FAILED' || call.status === 'TIMED_OUT';
  const onStderr = failed && name !== null && !STREAMING_TOOLS.has(name);
  return {
    kind: 'tool',
    id: call.id,
    callId: call.callId,
    name,
    args: call.args,
    seq: call.seq,
    status: TOOL_STATUS[call.status],
    stdout: onStderr ? '' : head,
    stderr: onStderr ? head : '',
    // The head is what is on screen and `resultBytes` is what the tool produced, so the two
    // together are what decides whether the row admits to having been cut. Measured in UTF-8
    // bytes because that is the unit the runtime capped the head in.
    shownBytes: utf8ByteLength(head),
    totalBytes: call.resultBytes,
    exitCode: call.exitCode,
    durationMs: call.durationMs,
    startedAt: Date.parse(call.startedAt),
  };
}

/**
 * Reports whether a turn ended because the operator stopped it.
 *
 * A turn that never ran also ends as `CANCELLED`: the API gives a claim on the chat back that way
 * when two messages raced, and records why in `error`. Nobody watched that turn, so it gets no
 * notice; a cancellation the operator asked for carries no error at all.
 *
 * @param turn - The persisted turn.
 * @returns `true` when the turn was stopped while it was somebody's turn to watch.
 */
function wasStopped(turn: TurnView): boolean {
  return turn.status === 'CANCELLED' && turn.error === null;
}

/**
 * Reports whether a turn's recorded error is a failure the transcript should show.
 *
 * `FAILED` is a turn that was accepted and did not finish its work, and every one of them gets a
 * row — the newest and the ones before it alike, since a chat that failed, was asked again and
 * failed differently is a chat whose history is those two failures.
 *
 * `CANCELLED` never does. Either the operator stopped the turn, which the cancellation notice
 * already says in words meant for them, or the claim on the chat was given back before any work
 * started because a second request won the race — and that one records an internal line about the
 * race, addressed to whoever reads the row, not to whoever reads the chat. The caller that lost
 * the race was already answered with the same fact, as an error on the request it made.
 *
 * @param turn - The persisted turn.
 * @returns `true` when the turn's error belongs on screen.
 */
function hasVisibleFailure(turn: TurnView): turn is TurnView & { error: string } {
  return turn.status === 'FAILED' && turn.error !== null;
}

/**
 * Places every displayed row on the chat's one timeline.
 *
 * The sort is stable and the three lists are concatenated in the order a row can cause the next
 * one: a message, then the tool calls it set off, then the notice that says the turn was stopped.
 * Rows that share a millisecond therefore keep that order, and calls of one turn keep the `seq`
 * order the API listed them in.
 *
 * @param messages - The chat's messages, already in `seq` order.
 * @param detail - The `GET /api/chats/:id` payload.
 * @returns Every item with the instant it belongs at, oldest first.
 */
function timedItems(messages: readonly MessageView[], detail: ChatDetail): TimedItem[] {
  const fromMessages = messages.flatMap((message) => {
    const item = toMessageItem(message);
    return item === null ? [] : [{ at: Date.parse(message.createdAt), item }];
  });
  const fromCalls = detail.toolCalls.map((call) => ({
    at: Date.parse(call.startedAt),
    item: toToolItem(call),
  }));
  const fromStops = detail.turns.filter(wasStopped).map((turn) => ({
    at: Date.parse(turn.finishedAt ?? turn.queuedAt),
    item: {
      kind: 'notice' as const,
      id: `${turn.id}-cancelled`,
      tone: 'warning' as const,
      text: TURN_CANCELLED_NOTICE,
    },
  }));
  const fromFailures = detail.turns.filter(hasVisibleFailure).map((turn) => ({
    at: Date.parse(turn.finishedAt ?? turn.queuedAt),
    item: {
      kind: 'error' as const,
      id: `${turn.id}-error`,
      code: TURN_FAILED_CODE,
      message: turn.error,
      turnId: turn.id,
    },
  }));
  return [...fromMessages, ...fromCalls, ...fromStops, ...fromFailures].sort(
    (left, right) => left.at - right.at,
  );
}

/**
 * Rebuilds the transcript of a chat that already has history.
 *
 * @param detail - The `GET /api/chats/:id` payload.
 * @returns Items in display order, the phase, the live turn id, its start and the last prompt.
 */
export function mapChatDetail(detail: ChatDetail): MappedChat {
  const messages = [...detail.messages].sort((left, right) => left.seq - right.seq);
  const items: TranscriptItem[] = timedItems(messages, detail).map((entry) => entry.item);

  const latest = detail.turns.at(-1);
  const phase = latest === undefined ? 'idle' : PHASE_BY_TURN_STATUS[latest.status];
  const lastPrompt = messages.filter((message) => message.role === 'USER').at(-1)?.content ?? null;
  const startedAtIso = latest?.startedAt ?? null;

  return {
    items,
    phase,
    activeTurnId: latest !== undefined && LIVE_PHASES.has(phase) ? latest.id : null,
    startedAt: startedAtIso === null ? null : Date.parse(startedAtIso),
    lastPrompt,
  };
}
