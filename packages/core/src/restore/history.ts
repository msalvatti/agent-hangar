/**
 * The history window a turn sends to the model.
 *
 * Layer: domain (pure).
 *
 * A long chat outgrows any context window, so the window keeps the newest messages that fit and
 * replaces the rest with one compaction item. The first user message is always kept: it states
 * the task, and a model that loses it starts guessing what it is working on.
 *
 * Security: message content arrives already redacted from the repository layer (data-model
 * invariant 1). It is copied into model input verbatim and is never used to build an error
 * message, so a value that slipped through redaction cannot escape through a thrown error.
 */
import type { ConversationItem } from '../model/types.ts';
import { assertNever } from '../workspace/lifecycle.ts';
import type { MessageRole } from '../workspace/types.ts';

import { DEFAULT_HISTORY_BUDGET } from './limits.ts';

/** Most tool-summary lines the compaction item lists before eliding the rest. */
export const MAX_COMPACTION_TOOL_LINES = 20;

/** One message of the stored history, as the window reads it. */
export interface HistoryMessage {
  /** Monotonic, gap-free position within the chat. */
  seq: number;
  role: MessageRole;
  /** Already redacted by the repository layer. */
  content: string;
}

/** How much history a turn may carry. */
export interface HistoryBudget {
  /** Most messages to keep, including the anchor. */
  maxMessages: number;
  /** Most characters of content to keep, counted across kept messages. */
  maxChars: number;
}

/** The selected window, in the order the model receives it. */
export interface HistoryWindow {
  /** Model input: the kept messages plus the compaction item when anything was dropped. */
  items: ConversationItem[];
  /** The kept source messages, in the same order, without the synthesised compaction item. */
  retained: HistoryMessage[];
  /** How many messages the budget forced out. */
  dropped: number;
  /** How many source messages were kept. */
  kept: number;
}

/**
 * Maps a stored message to a model conversation item.
 *
 * Tool summaries become `system` items rather than `assistant` ones: they are notes about what
 * happened, not something the model said, and letting the model read its own summaries back as
 * its own words invites it to invent more of them.
 *
 * @param message - Stored message.
 * @returns The conversation item.
 */
export function toConversationItem(message: HistoryMessage): ConversationItem {
  switch (message.role) {
    case 'USER':
      return { role: 'user', content: message.content };
    case 'ASSISTANT':
      return { role: 'assistant', content: message.content };
    case 'SYSTEM':
    case 'TOOL_SUMMARY':
      return { role: 'system', content: message.content };
    default:
      return assertNever(message.role);
  }
}

/**
 * Builds the compaction item's text.
 *
 * @param dropped - The messages the budget forced out, in sequence order.
 * @returns A count line, followed by the dropped tool activity when there was any.
 */
function compactionText(dropped: readonly HistoryMessage[]): string {
  const header = `${dropped.length} earlier messages omitted to fit the context window.`;
  const toolLines = dropped
    .filter((message) => message.role === 'TOOL_SUMMARY')
    .map((message) => `- ${message.content}`);
  if (toolLines.length === 0) {
    return header;
  }
  const shown = toolLines.slice(0, MAX_COMPACTION_TOOL_LINES);
  const remainder = toolLines.length - shown.length;
  const overflow = remainder === 0 ? [] : [`- … ${remainder} more`];
  return [header, 'Earlier tool activity:', ...shown, ...overflow].join('\n');
}

/**
 * Chooses which messages fit the budget, newest first.
 *
 * @param ordered - Every message in sequence order.
 * @param anchor - The first user message, always kept; `undefined` for a history without one.
 * @param budget - Message and character ceilings.
 * @returns The kept messages in sequence order, excluding the anchor.
 */
function fitNewestFirst(
  ordered: readonly HistoryMessage[],
  anchor: HistoryMessage | undefined,
  budget: HistoryBudget,
): HistoryMessage[] {
  // The anchor is reserved first: it counts against both ceilings and is kept even when it alone
  // exceeds the character budget, because a turn without the task statement is worse than a long one.
  let count = anchor === undefined ? 0 : 1;
  let chars = anchor === undefined ? 0 : anchor.content.length;
  const kept: HistoryMessage[] = [];
  for (const message of ordered.toReversed()) {
    if (message === anchor) {
      continue;
    }
    if (count >= budget.maxMessages || chars + message.content.length > budget.maxChars) {
      break;
    }
    count += 1;
    chars += message.content.length;
    kept.push(message);
  }
  return kept.reverse();
}

/**
 * Selects the history window for a turn.
 *
 * @param messages - Every stored message of the chat, in any order.
 * @param budget - Ceilings to apply; defaults to {@link DEFAULT_HISTORY_BUDGET}.
 * @returns The model items, the kept source messages and how many were dropped.
 */
export function buildHistoryWindow(
  messages: readonly HistoryMessage[],
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
): HistoryWindow {
  const ordered = messages.toSorted((left, right) => left.seq - right.seq);
  const anchor = ordered.find((message) => message.role === 'USER');
  const tail = fitNewestFirst(ordered, anchor, budget);
  const retained = anchor === undefined ? tail : [anchor, ...tail];
  const keptSet = new Set(retained);
  const dropped = ordered.filter((message) => !keptSet.has(message));

  const items: ConversationItem[] = [];
  if (anchor !== undefined) {
    items.push(toConversationItem(anchor));
  }
  if (dropped.length > 0) {
    items.push({ role: 'system', content: compactionText(dropped) });
  }
  items.push(...tail.map(toConversationItem));

  return { items, retained, dropped: dropped.length, kept: retained.length };
}
