/**
 * Tests for `mapChatDetail`: rebuilding a transcript from persisted history.
 */
import type { ChatDetail } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { mapChatDetail } from './map-chat-detail';

/** Timestamp every fixture row shares unless it needs its own. */
const AT = '2026-08-19T10:00:00.000Z';

/**
 * Builds a chat detail with only the fields under test filled in.
 *
 * @param overrides - Parts of the detail this test cares about.
 * @returns A complete `ChatDetail`.
 */
function detailWith(overrides: Partial<ChatDetail>): ChatDetail {
  return {
    chat: {
      id: 'chat-1',
      title: 'Fix flaky auth test',
      status: 'ACTIVE',
      repoUrl: 'https://github.com/acme/api',
      baseBranch: 'main',
      workBranch: null,
      lastPushedSha: null,
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      lastTurnStatus: null,
    },
    messages: [],
    turns: [],
    toolCalls: [],
    workspace: null,
    ...overrides,
  };
}

/**
 * Builds one turn.
 *
 * @param status - Turn status.
 * @param extra - Error and start time, when the test needs them.
 * @returns A turn view.
 */
function turn(
  status: ChatDetail['turns'][number]['status'],
  extra: { error?: string; startedAt?: string } = {},
) {
  return {
    id: 'turn-1',
    status,
    model: 'gpt-5.6-sol',
    workspaceId: null,
    usage: { inputTokens: null, outputTokens: null, stepCount: 0 },
    error: extra.error ?? null,
    queuedAt: AT,
    startedAt: extra.startedAt ?? null,
    finishedAt: null,
  };
}

describe('mapChatDetail', () => {
  // Messages come back in `seq` order regardless of how the API listed them.
  it('orders messages by seq and maps each displayed role', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          { id: 'm2', turnId: null, seq: 2, role: 'ASSISTANT', content: 'answer', createdAt: AT },
          { id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'question', createdAt: AT },
          { id: 'm3', turnId: null, seq: 3, role: 'SYSTEM', content: 'restored', createdAt: AT },
        ],
      }),
    );
    expect(mapped.items.map((item) => item.kind)).toEqual(['user', 'assistant', 'notice']);
    expect(mapped.lastPrompt).toBe('question');
  });

  // Compaction summaries are model-facing and never rendered.
  it('drops TOOL_SUMMARY messages', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          {
            id: 'm1',
            turnId: null,
            seq: 1,
            role: 'TOOL_SUMMARY',
            content: 'summary',
            createdAt: AT,
          },
        ],
      }),
    );
    expect(mapped.items).toEqual([]);
    expect(mapped.lastPrompt).toBeNull();
  });

  // Tool calls appear under the prompt of the turn that produced them, in `seq` order.
  it('interleaves tool calls after their turn prompt', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          { id: 'm1', turnId: 'turn-1', seq: 1, role: 'USER', content: 'go', createdAt: AT },
          { id: 'm2', turnId: 'turn-1', seq: 2, role: 'ASSISTANT', content: 'done', createdAt: AT },
        ],
        toolCalls: [
          toolCall({ id: 't2', seq: 2, toolName: 'read_file' }),
          toolCall({ id: 't1', seq: 1, toolName: 'run_shell' }),
        ],
      }),
    );
    expect(mapped.items.map((item) => item.id)).toEqual(['m1', 't1', 't2', 'm2']);
  });

  // Every persisted tool status has a transcript counterpart.
  it.each([
    ['RUNNING', 'running'],
    ['SUCCEEDED', 'succeeded'],
    ['FAILED', 'failed'],
    ['TIMED_OUT', 'timed_out'],
  ] as const)('maps tool status %s', (status, expected) => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          { id: 'm1', turnId: 'turn-1', seq: 1, role: 'USER', content: 'go', createdAt: AT },
        ],
        toolCalls: [toolCall({ id: 't1', seq: 1, toolName: 'run_shell', status })],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', status: expected });
  });

  // A tool call with no captured output still renders, with an empty body.
  it('handles a tool call without output', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          { id: 'm1', turnId: 'turn-1', seq: 1, role: 'USER', content: 'go', createdAt: AT },
        ],
        toolCalls: [{ ...toolCall({ id: 't1', seq: 1, toolName: 'run_shell' }), resultHead: null }],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', stdout: '', shownBytes: 0 });
  });

  // A tool name the schema does not know still renders, as a shell call.
  it('falls back for an unknown tool name', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          { id: 'm1', turnId: 'turn-1', seq: 1, role: 'USER', content: 'go', createdAt: AT },
        ],
        toolCalls: [toolCall({ id: 't1', seq: 1, toolName: 'invented_tool' })],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', name: 'run_shell' });
  });

  // Every persisted turn status has a phase, and only live ones keep the stream open.
  it.each([
    ['QUEUED', 'queued', 'turn-1'],
    ['PREPARING', 'preparing', 'turn-1'],
    ['RUNNING', 'running', 'turn-1'],
    ['SUCCEEDED', 'succeeded', null],
    ['FAILED', 'failed', null],
    ['CANCELLED', 'cancelled', null],
  ] as const)('maps turn status %s', (status, phase, activeTurnId) => {
    const mapped = mapChatDetail(detailWith({ turns: [turn(status)] }));
    expect(mapped.phase).toBe(phase);
    expect(mapped.activeTurnId).toBe(activeTurnId);
  });

  // A chat with no turn yet is idle and follows nothing.
  it('is idle without any turn', () => {
    const mapped = mapChatDetail(detailWith({}));
    expect(mapped.phase).toBe('idle');
    expect(mapped.activeTurnId).toBeNull();
    expect(mapped.startedAt).toBeNull();
  });

  // A failed turn contributes an error row so the failure is visible in the transcript itself.
  it('appends an error item for a failed turn', () => {
    const mapped = mapChatDetail(detailWith({ turns: [turn('FAILED', { error: 'boom' })] }));
    expect(mapped.items.at(-1)).toMatchObject({ kind: 'error', message: 'boom' });
  });

  // The start time drives the elapsed timer in the header pill.
  it('parses the turn start time', () => {
    const mapped = mapChatDetail(detailWith({ turns: [turn('RUNNING', { startedAt: AT })] }));
    expect(mapped.startedAt).toBe(Date.parse(AT));
  });
});

/**
 * Builds one tool-call log row.
 *
 * @param overrides - Id, sequence, tool name and status.
 * @returns A tool-call view.
 */
function toolCall(overrides: {
  id: string;
  seq: number;
  toolName: string;
  status?: ChatDetail['toolCalls'][number]['status'];
}) {
  return {
    id: overrides.id,
    turnId: 'turn-1',
    jobRunId: null,
    callId: `call-${overrides.id}`,
    seq: overrides.seq,
    toolName: overrides.toolName,
    args: { command: 'ls' },
    resultHead: 'output',
    resultBytes: 6,
    exitCode: 0,
    status: overrides.status ?? 'SUCCEEDED',
    startedAt: AT,
    finishedAt: AT,
    durationMs: 12,
  };
}
