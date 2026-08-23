/**
 * Unit tests for the history window.
 *
 * Layer: unit.
 * Goal: roles map to the model's vocabulary, both ceilings are honoured at their boundaries, the
 * first user message survives any budget, and dropped messages are represented by exactly one
 * compaction item that lists the tool activity it replaced.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import type { MessageRole } from '../workspace/types.ts';

import { buildHistoryWindow, MAX_COMPACTION_TOOL_LINES, toConversationItem } from './history.ts';
import type { HistoryMessage } from './history.ts';

/** Budget large enough that nothing is dropped unless a test says so. */
const ROOMY = { maxMessages: 100, maxChars: 100_000 };

/**
 * Builds a stored message.
 *
 * @param seq - Position within the chat.
 * @param role - Author.
 * @param content - Message text.
 * @returns The stored message.
 */
function message(seq: number, role: MessageRole, content: string): HistoryMessage {
  return { seq, role, content };
}

describe('toConversationItem', () => {
  /**
   * Four stored roles collapse to the model's three: tool summaries are notes about what happened,
   * so they arrive as system context rather than as something the model said.
   */
  it('maps every stored role', () => {
    expect(toConversationItem(message(1, 'USER', 'a'))).toEqual({ role: 'user', content: 'a' });
    expect(toConversationItem(message(2, 'ASSISTANT', 'b'))).toEqual({
      role: 'assistant',
      content: 'b',
    });
    expect(toConversationItem(message(3, 'SYSTEM', 'c'))).toEqual({ role: 'system', content: 'c' });
    expect(toConversationItem(message(4, 'TOOL_SUMMARY', 'd'))).toEqual({
      role: 'system',
      content: 'd',
    });
  });

  /**
   * A role this build does not know is reported rather than silently sent as user input.
   */
  it('reports an unknown role', () => {
    const unknown = message(1, 'ORACLE' as unknown as MessageRole, 'x');
    expect(() => toConversationItem(unknown)).toThrow(/unhandled case: "ORACLE"/);
  });
});

describe('buildHistoryWindow', () => {
  /**
   * A chat with no messages yet produces an empty window rather than a lone compaction item.
   */
  it('handles an empty history', () => {
    expect(buildHistoryWindow([], ROOMY)).toEqual({
      items: [],
      retained: [],
      dropped: 0,
      kept: 0,
    });
  });

  /**
   * Under budget everything is kept in sequence order and no compaction item appears, which is the
   * shape of every short chat.
   */
  it('keeps everything under budget', () => {
    const messages = [
      message(1, 'USER', 'add auth'),
      message(2, 'ASSISTANT', 'on it'),
      message(3, 'TOOL_SUMMARY', 'ran `pnpm test` → exit 0 (12 s)'),
    ];
    const window = buildHistoryWindow(messages, ROOMY);
    expect(window.dropped).toBe(0);
    expect(window.kept).toBe(3);
    expect(window.items).toEqual([
      { role: 'user', content: 'add auth' },
      { role: 'assistant', content: 'on it' },
      { role: 'system', content: 'ran `pnpm test` → exit 0 (12 s)' },
    ]);
    expect(window.retained).toEqual(messages);
  });

  /**
   * Messages arrive from a repository query whose order is not guaranteed, so the window sorts by
   * sequence and does not mutate the caller's array.
   */
  it('sorts by sequence without mutating the input', () => {
    const messages = [
      message(3, 'ASSISTANT', 'c'),
      message(1, 'USER', 'a'),
      message(2, 'USER', 'b'),
    ];
    const before = structuredClone(messages);
    const window = buildHistoryWindow(messages, ROOMY);
    expect(window.retained.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(messages).toEqual(before);
  });

  /**
   * With a message ceiling the newest messages win, the first user message is kept as the anchor,
   * and exactly one compaction item reports how many were dropped.
   */
  it('keeps the anchor and the newest messages under a message ceiling', () => {
    const messages = [
      message(1, 'USER', 'add auth'),
      ...Array.from({ length: 9 }, (_unused, index) =>
        message(index + 2, 'ASSISTANT', `step ${index + 2}`),
      ),
    ];
    const window = buildHistoryWindow(messages, { maxMessages: 4, maxChars: 100_000 });
    expect(window.kept).toBe(4);
    expect(window.dropped).toBe(6);
    expect(window.retained.map((entry) => entry.seq)).toEqual([1, 8, 9, 10]);
    expect(window.items[0]).toEqual({ role: 'user', content: 'add auth' });
    expect(window.items[1]).toEqual({
      role: 'system',
      content: '6 earlier messages omitted to fit the context window.',
    });
    expect(window.items).toHaveLength(5);
  });

  /**
   * The character ceiling is inclusive: a message that exactly fills the remaining budget is kept,
   * and one character more drops it.
   */
  it('treats the character ceiling as inclusive', () => {
    const anchor = message(1, 'USER', 'ab');
    const fits = message(2, 'ASSISTANT', 'cde');
    const overflows = message(2, 'ASSISTANT', 'cdef');
    expect(buildHistoryWindow([anchor, fits], { maxMessages: 10, maxChars: 5 }).dropped).toBe(0);
    expect(buildHistoryWindow([anchor, overflows], { maxMessages: 10, maxChars: 5 }).dropped).toBe(
      1,
    );
  });

  /**
   * The task statement survives any budget: a turn that has forgotten what it was asked to do is
   * worse than a turn that is slightly over its character estimate.
   */
  it('keeps the anchor even when it alone exceeds the budget', () => {
    const anchor = message(1, 'USER', 'x'.repeat(100));
    const window = buildHistoryWindow([anchor, message(2, 'ASSISTANT', 'y')], {
      maxMessages: 10,
      maxChars: 10,
    });
    expect(window.retained).toEqual([anchor]);
    expect(window.dropped).toBe(1);
    expect(window.items[0]).toEqual({ role: 'user', content: 'x'.repeat(100) });
  });

  /**
   * A history without a user message — only the archive notice, say — has no anchor to reserve and
   * still windows normally.
   */
  it('works without a user message', () => {
    const messages = [message(1, 'SYSTEM', 'Workspace archived; no uncommitted changes.')];
    const window = buildHistoryWindow(messages, ROOMY);
    expect(window.retained).toEqual(messages);
    expect(window.items).toEqual([{ role: 'system', content: messages[0]!.content }]);
  });

  /**
   * When the anchor also falls inside the newest-first window it must appear once, not twice.
   */
  it('does not duplicate an anchor that is also in the window', () => {
    const messages = [message(1, 'USER', 'a'), message(2, 'ASSISTANT', 'b')];
    const window = buildHistoryWindow(messages, ROOMY);
    expect(window.items).toHaveLength(2);
    expect(window.retained).toHaveLength(2);
  });

  /**
   * The compaction item is what keeps a long chat coherent: it lists the tool activity that was
   * dropped, oldest first, so the model knows what it already did.
   */
  it('lists dropped tool activity oldest first', () => {
    const messages = [
      message(1, 'USER', 'add auth'),
      message(2, 'TOOL_SUMMARY', 'read README.md'),
      message(3, 'TOOL_SUMMARY', 'wrote src/auth.ts (42 bytes)'),
      message(4, 'ASSISTANT', 'done'),
    ];
    const window = buildHistoryWindow(messages, { maxMessages: 2, maxChars: 100_000 });
    expect(window.items[1]).toEqual({
      role: 'system',
      content:
        '2 earlier messages omitted to fit the context window.\nEarlier tool activity:\n- read README.md\n- wrote src/auth.ts (42 bytes)',
    });
  });

  /**
   * A very long run of tool calls is itself capped, so the compaction item cannot grow without
   * bound; the elision names how many lines it stands for.
   */
  it('caps the tool activity list', () => {
    const total = MAX_COMPACTION_TOOL_LINES + 5;
    const messages = [
      message(1, 'USER', 'add auth'),
      ...Array.from({ length: total }, (_unused, index) =>
        message(index + 2, 'TOOL_SUMMARY', `read file-${index}.ts`),
      ),
      message(total + 2, 'ASSISTANT', 'done'),
    ];
    const window = buildHistoryWindow(messages, { maxMessages: 2, maxChars: 100_000 });
    const compaction = window.items[1];
    expect(compaction).toBeDefined();
    const lines = (compaction as { content: string }).content.split('\n');
    expect(lines[0]).toBe(`${total} earlier messages omitted to fit the context window.`);
    expect(lines[2]).toBe('- read file-0.ts');
    expect(lines).toHaveLength(2 + MAX_COMPACTION_TOOL_LINES + 1);
    expect(lines.at(-1)).toBe('- … 5 more');
  });

  /**
   * When nothing dropped was a tool summary the item is just the count, with no dangling "Earlier
   * tool activity" heading.
   */
  it('omits the tool activity section when there was none', () => {
    const messages = [
      message(1, 'USER', 'add auth'),
      message(2, 'ASSISTANT', 'first'),
      message(3, 'ASSISTANT', 'second'),
    ];
    const window = buildHistoryWindow(messages, { maxMessages: 2, maxChars: 100_000 });
    expect(window.items[1]).toEqual({
      role: 'system',
      content: '1 earlier messages omitted to fit the context window.',
    });
  });

  /**
   * Omitting the budget applies the documented default, so a caller that does not care gets the
   * same window as one that passes the constant.
   */
  it('applies the default budget', () => {
    const messages = [message(1, 'USER', 'a'), message(2, 'ASSISTANT', 'b')];
    expect(buildHistoryWindow(messages)).toEqual(buildHistoryWindow(messages, ROOMY));
  });
});

describe('what the history window reserves and counts', () => {
  /**
   * The first user message is the task statement, and it is kept whatever the budget says — but a
   * history that has none must not reserve a place for one it does not have, or the window keeps
   * one message fewer than the budget allows for every chat that opens with anything else.
   */
  it('reserves nothing when the history opens with no user message', () => {
    const messages = [
      { seq: 1, role: 'ASSISTANT' as const, content: 'a' },
      { seq: 2, role: 'ASSISTANT' as const, content: 'b' },
    ];

    const window = buildHistoryWindow(messages, { maxMessages: 2, maxChars: 100 });

    expect(window.retained).toHaveLength(2);
  });

  /**
   * The character budget is spent, not recovered: counted the wrong way round it grows with every
   * message kept, and a window that should have stopped keeps the whole chat.
   */
  it('stops once the characters it has kept fill the budget', () => {
    const messages = [
      { seq: 1, role: 'USER' as const, content: 'u' },
      { seq: 2, role: 'ASSISTANT' as const, content: 'x'.repeat(10) },
      { seq: 3, role: 'ASSISTANT' as const, content: 'y'.repeat(10) },
      { seq: 4, role: 'ASSISTANT' as const, content: 'z'.repeat(10) },
    ];

    const window = buildHistoryWindow(messages, { maxMessages: 10, maxChars: 25 });

    expect(window.retained.map((message) => message.seq)).toStrictEqual([1, 3, 4]);
  });

  /**
   * The anchor is the first message the person wrote, not simply the first message: an assistant
   * greeting ahead of it is history, and anchoring on it would reserve the wrong message and drop
   * the task statement when the budget got tight.
   */
  it('anchors on the first user message rather than the first message', () => {
    const messages = [
      { seq: 1, role: 'ASSISTANT' as const, content: 'greeting' },
      { seq: 2, role: 'USER' as const, content: 'the task' },
      { seq: 3, role: 'ASSISTANT' as const, content: 'z'.repeat(40) },
    ];

    const window = buildHistoryWindow(messages, { maxMessages: 2, maxChars: 60 });

    expect(window.retained.map((message) => message.content)).toStrictEqual([
      'the task',
      'z'.repeat(40),
    ]);
  });
});
