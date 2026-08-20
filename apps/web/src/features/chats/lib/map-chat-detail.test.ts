/**
 * Tests for `mapChatDetail`: rebuilding a transcript from persisted history.
 *
 * The payloads here are shaped the way `GET /api/chats/:id` answers, which is the part that
 * matters: the API writes a user message before the turn it starts exists, so `turnId` is null on
 * every one of them and nothing in the payload links a prompt to the rows its turn produced.
 */
import type { ChatDetail, MessageView, ToolCallView, TurnView } from '@agent-hangar/core';
import { pushedNoticeText } from '@agent-hangar/core';
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

/** Work branch of the two-turn chat, as the agent names it. */
const WORK_BRANCH = 'agent/1a2b3c4d';

/** Commit the first turn pushed. */
const PUSHED_SHA = '9f8e7d6c5b4a39281706';

/**
 * Builds the payload of a chat that ran two turns: one that read the repository and pushed, and
 * one the operator stopped part way through.
 *
 * Every row carries the timestamp the database would have given it, and no user message names a
 * turn — which is what the schema produces, since the message is written before the turn row.
 *
 * @returns The `GET /api/chats/:id` payload.
 */
function twoTurnChat(): ChatDetail {
  const messages: MessageView[] = [
    {
      id: 'm1',
      turnId: null,
      seq: 1,
      role: 'USER',
      content: 'Rename the retry helper and push the change.',
      createdAt: '2026-08-19T10:00:00.000Z',
    },
    {
      id: 'm2',
      turnId: 'turn-1',
      seq: 2,
      role: 'SYSTEM',
      content: pushedNoticeText(WORK_BRANCH, PUSHED_SHA),
      createdAt: '2026-08-19T10:00:12.000Z',
    },
    {
      id: 'm3',
      turnId: 'turn-1',
      seq: 3,
      role: 'TOOL_SUMMARY',
      content: 'run_shell: git push (exit 0)',
      createdAt: '2026-08-19T10:00:15.000Z',
    },
    {
      id: 'm4',
      turnId: 'turn-1',
      seq: 4,
      role: 'ASSISTANT',
      content: 'Renamed it and pushed the branch.',
      createdAt: '2026-08-19T10:00:15.100Z',
    },
    {
      id: 'm5',
      turnId: null,
      seq: 5,
      role: 'USER',
      content: 'Now run the whole suite.',
      createdAt: '2026-08-19T10:01:00.000Z',
    },
  ];
  const turns: TurnView[] = [
    {
      id: 'turn-1',
      status: 'SUCCEEDED',
      model: 'gpt-5.6-sol',
      workspaceId: 'workspace-1',
      usage: { inputTokens: 4_120, outputTokens: 980, stepCount: 3 },
      error: null,
      queuedAt: '2026-08-19T10:00:00.100Z',
      startedAt: '2026-08-19T10:00:02.000Z',
      finishedAt: '2026-08-19T10:00:15.100Z',
    },
    {
      id: 'turn-2',
      status: 'CANCELLED',
      model: 'gpt-5.6-sol',
      workspaceId: 'workspace-1',
      usage: { inputTokens: null, outputTokens: null, stepCount: 1 },
      error: null,
      queuedAt: '2026-08-19T10:01:00.100Z',
      startedAt: '2026-08-19T10:01:01.000Z',
      finishedAt: '2026-08-19T10:01:21.300Z',
    },
  ];
  const toolCalls: ToolCallView[] = [
    {
      id: 't1',
      turnId: 'turn-1',
      jobRunId: null,
      callId: 'call-1',
      seq: 0,
      toolName: 'list_dir',
      args: { path: 'src' },
      resultHead: 'retry.ts\nindex.ts\n',
      resultBytes: 18,
      exitCode: null,
      status: 'SUCCEEDED',
      startedAt: '2026-08-19T10:00:07.400Z',
      finishedAt: '2026-08-19T10:00:07.480Z',
      durationMs: 80,
    },
    {
      id: 't2',
      turnId: 'turn-1',
      jobRunId: null,
      callId: 'call-2',
      seq: 1,
      toolName: 'run_shell',
      args: { command: 'git push origin HEAD' },
      resultHead: 'Everything up-to-date\n',
      resultBytes: 22,
      exitCode: 0,
      status: 'SUCCEEDED',
      startedAt: '2026-08-19T10:00:09.100Z',
      finishedAt: '2026-08-19T10:00:11.900Z',
      durationMs: 2_800,
    },
    {
      id: 't3',
      turnId: 'turn-2',
      jobRunId: null,
      callId: 'call-3',
      seq: 0,
      toolName: 'run_shell',
      args: { command: 'pnpm test' },
      resultHead: 'running tests…\n',
      resultBytes: 16,
      exitCode: null,
      status: 'FAILED',
      startedAt: '2026-08-19T10:01:04.000Z',
      finishedAt: '2026-08-19T10:01:21.300Z',
      durationMs: 17_300,
    },
  ];
  return detailWith({
    chat: {
      ...detailWith({}).chat,
      workBranch: WORK_BRANCH,
      lastPushedSha: PUSHED_SHA,
      lastTurnStatus: 'CANCELLED',
    },
    messages,
    turns,
    toolCalls,
  });
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

  // The defect this file exists for: nothing in the payload links a prompt to its turn, so a
  // mapper that waits for a user message naming the turn drops every tool call the chat made.
  it('keeps the tool calls of a chat whose user messages name no turn', () => {
    const detail = twoTurnChat();
    expect(detail.messages.filter((message) => message.role === 'USER')).toSatisfy(
      (users: MessageView[]) => users.every((user) => user.turnId === null),
    );

    const mapped = mapChatDetail(detail);

    const tools = mapped.items.filter((item) => item.kind === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
  });

  // Each turn's work reads between the prompt that asked for it and the answer that followed.
  it('places every row of a two-turn chat in the order it happened', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items.map((item) => item.id)).toEqual([
      'm1',
      't1',
      't2',
      'm2',
      'm4',
      'm5',
      't3',
      'turn-2-cancelled',
    ]);
  });

  // A push is the one thing a turn does that outlives its workspace, so the worker stores the
  // notice and the reloaded transcript shows it as the success the live stream showed.
  it('rebuilds the push notice with the tone the live stream used', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items[3]).toEqual({
      kind: 'notice',
      id: 'm2',
      tone: 'success',
      text: 'Pushed agent/1a2b3c4d @ 9f8e7d6',
    });
  });

  // Nothing persists the cancellation notice, but the turn's own status is the same fact.
  it('rebuilds the cancellation notice from the stopped turn', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items.at(-1)).toEqual({
      kind: 'notice',
      id: 'turn-2-cancelled',
      tone: 'warning',
      text: 'Turn cancelled.',
    });
  });

  // The stopped call keeps what it was running and how it ended, which is what a reader needs to
  // know; a command killed by a signal reports no exit code, and the row says so rather than
  // inventing one.
  it('keeps the arguments and the outcome of a stopped tool call', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items[6]).toMatchObject({
      kind: 'tool',
      name: 'run_shell',
      args: { command: 'pnpm test' },
      status: 'failed',
      exitCode: null,
      durationMs: 17_300,
    });
  });

  // A turn the API cancelled to give a contested claim back was never on screen: it has an error
  // where a real cancellation has none, and it earns no notice.
  it('does not announce a turn that was cancelled to release a claim', () => {
    const mapped = mapChatDetail(
      detailWith({
        turns: [turn('CANCELLED', { error: 'Released: another message claimed the chat' })],
      }),
    );

    expect(mapped.items.filter((item) => item.kind === 'notice')).toEqual([]);
    expect(mapped.items.at(-1)).toMatchObject({ kind: 'error' });
  });

  // What is on screen is measured in the unit the runtime capped it in, so a head full of
  // multi-byte characters is not mistaken for a result that was cut.
  it('measures the shown output in UTF-8 bytes', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
        toolCalls: [
          {
            ...toolCall({ id: 't1', seq: 1, toolName: 'read_file' }),
            resultHead: '日本語',
            resultBytes: 9,
          },
        ],
      }),
    );

    expect(mapped.items[1]).toMatchObject({ kind: 'tool', shownBytes: 9, totalBytes: 9 });
  });

  // Tool calls appear under the prompt of the turn that produced them, in `seq` order.
  it('interleaves tool calls after their turn prompt', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          {
            id: 'm1',
            turnId: null,
            seq: 1,
            role: 'USER',
            content: 'go',
            createdAt: '2026-08-19T10:00:00.000Z',
          },
          {
            id: 'm2',
            turnId: 'turn-1',
            seq: 2,
            role: 'ASSISTANT',
            content: 'done',
            createdAt: '2026-08-19T10:00:30.000Z',
          },
        ],
        toolCalls: [
          {
            ...toolCall({ id: 't2', seq: 2, toolName: 'read_file' }),
            startedAt: '2026-08-19T10:00:20.000Z',
          },
          {
            ...toolCall({ id: 't1', seq: 1, toolName: 'run_shell' }),
            startedAt: '2026-08-19T10:00:10.000Z',
          },
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
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
        toolCalls: [toolCall({ id: 't1', seq: 1, toolName: 'run_shell', status })],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', status: expected });
  });

  // A tool call with no captured output still renders, with an empty body.
  it('handles a tool call without output', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
        toolCalls: [{ ...toolCall({ id: 't1', seq: 1, toolName: 'run_shell' }), resultHead: null }],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', stdout: '', shownBytes: 0 });
  });

  // A tool name the schema does not know still renders, as a shell call.
  it('falls back for an unknown tool name', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
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
