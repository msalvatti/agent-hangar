/**
 * Turns the persisted chat detail into the transcript model the shared renderer consumes.
 *
 * Layer: feature (lib).
 *
 * The API returns messages, turns and tool-call logs as separate lists; the transcript is one
 * ordered list. Rows are interleaved by turn, so a tool call always appears under the prompt that
 * triggered it, and the newest turn decides the phase the header pill shows.
 */
import { toolNameSchema } from '@agent-hangar/core';
import type { ChatDetail, MessageView, ToolCallView, TurnView } from '@agent-hangar/core';

import type { ToolCallStatus, TranscriptItem, TurnPhase } from '@/shared/transcript';

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
      return { kind: 'notice', id: message.id, tone: 'warning', text: message.content };
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
  const name = toolNameSchema.safeParse(call.toolName);
  const head = call.resultHead ?? '';
  return {
    kind: 'tool',
    id: call.id,
    callId: call.callId,
    name: name.success ? name.data : 'run_shell',
    args: call.args,
    seq: call.seq,
    status: TOOL_STATUS[call.status],
    stdout: head,
    stderr: '',
    shownBytes: head.length,
    totalBytes: call.resultBytes,
    exitCode: call.exitCode,
    durationMs: call.durationMs,
    startedAt: Date.parse(call.startedAt),
  };
}

/**
 * Rebuilds the transcript of a chat that already has history.
 *
 * @param detail - The `GET /api/chats/:id` payload.
 * @returns Items in display order, the phase, the live turn id, its start and the last prompt.
 */
export function mapChatDetail(detail: ChatDetail): MappedChat {
  const messages = [...detail.messages].sort((left, right) => left.seq - right.seq);
  const callsByTurn = new Map<string | null, ToolCallView[]>();
  for (const call of [...detail.toolCalls].sort((left, right) => left.seq - right.seq)) {
    callsByTurn.set(call.turnId, [...(callsByTurn.get(call.turnId) ?? []), call]);
  }

  const items: TranscriptItem[] = [];
  const emittedTurns = new Set<string>();
  for (const message of messages) {
    const item = toMessageItem(message);
    if (item !== null) {
      items.push(item);
    }
    if (message.turnId !== null && !emittedTurns.has(message.turnId) && message.role === 'USER') {
      emittedTurns.add(message.turnId);
      items.push(...(callsByTurn.get(message.turnId) ?? []).map(toToolItem));
    }
  }

  const latest = detail.turns.at(-1);
  const phase = latest === undefined ? 'idle' : PHASE_BY_TURN_STATUS[latest.status];
  if (latest !== undefined && latest.error !== null) {
    items.push({
      kind: 'error',
      id: `${latest.id}-error`,
      code: 'TURN_FAILED',
      message: latest.error,
    });
  }
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
