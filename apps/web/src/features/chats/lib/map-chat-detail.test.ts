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

import { prepareNoticeId } from '@/shared/transcript';

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
    preparedBranch: null,
    preparedSha: null,
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
 * The chat's messages, in the order the API writes them.
 *
 * No user message names a turn: the API writes the message and the turn as two rows, and only
 * the rows the worker adds afterwards — the push notice, the summary, the answer — carry the
 * turn id.
 *
 * @returns The messages of the two-turn chat.
 */
function twoTurnMessages(): MessageView[] {
  return [
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
}

/**
 * The two turns: one that finished and pushed, one the operator stopped part way through.
 *
 * @returns The turns of the two-turn chat, oldest first.
 */
function twoTurnTurns(): TurnView[] {
  return [
    {
      id: 'turn-1',
      status: 'SUCCEEDED',
      model: 'gpt-5.6-sol',
      workspaceId: 'workspace-1',
      usage: { inputTokens: 4_120, outputTokens: 980, stepCount: 3 },
      error: null,
      preparedBranch: null,
      preparedSha: null,
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
      preparedBranch: null,
      preparedSha: null,
      queuedAt: '2026-08-19T10:01:00.100Z',
      startedAt: '2026-08-19T10:01:01.000Z',
      finishedAt: '2026-08-19T10:01:21.300Z',
    },
  ];
}

/**
 * The tool calls of both turns, listed the way the API flattens them: turn by turn, each of
 * them in `seq` order.
 *
 * @returns The tool-call rows of the two-turn chat.
 */
/**
 * The two calls the first turn made: a listing, then the push that followed it.
 *
 * @returns Its tool-call rows, in `seq` order.
 */
function firstTurnCalls(): ToolCallView[] {
  return [
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
  ];
}

/**
 * The one call the second turn had started when the operator stopped it.
 *
 * @returns Its tool-call row.
 */
function secondTurnCalls(): ToolCallView[] {
  return [
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
}

function twoTurnCalls(): ToolCallView[] {
  return [...firstTurnCalls(), ...secondTurnCalls()];
}

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
  return detailWith({
    chat: {
      ...detailWith({}).chat,
      workBranch: WORK_BRANCH,
      lastPushedSha: PUSHED_SHA,
      lastTurnStatus: 'CANCELLED',
    },
    messages: twoTurnMessages(),
    turns: twoTurnTurns(),
    toolCalls: twoTurnCalls(),
  });
}

describe('mapChatDetail', () => {
  /** Messages come back in `seq` order regardless of how the API listed them. */
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

  /** Compaction summaries are model-facing and never rendered. */
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

  /**
   * The defect this file exists for: nothing in the payload links a prompt to its turn, so a mapper
   * that waits for a user message naming the turn drops every tool call the chat made.
   */
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

  /** Each turn's work reads between the prompt that asked for it and the answer that followed. */
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

  /**
   * A push is the one thing a turn does that outlives its workspace, so the worker stores the
   * notice and the reloaded transcript shows it as the success the live stream showed.
   */
  it('rebuilds the push notice with the tone the live stream used', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items[3]).toEqual({
      kind: 'notice',
      id: 'm2',
      tone: 'success',
      text: 'Pushed agent/1a2b3c4d @ 9f8e7d6',
    });
  });

  /** Nothing persists the cancellation notice, but the turn's own status is the same fact. */
  it('rebuilds the cancellation notice from the stopped turn', () => {
    const mapped = mapChatDetail(twoTurnChat());

    expect(mapped.items.at(-1)).toEqual({
      kind: 'notice',
      id: 'turn-2-cancelled',
      tone: 'warning',
      text: 'Turn cancelled.',
    });
  });

  /**
   * The stopped call keeps what it was running and how it ended, which is what a reader needs to
   * know; a command killed by a signal reports no exit code, and the row says so rather than
   * inventing one.
   */
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

  /**
   * A turn the API cancelled to give a contested claim back was never on screen: it has an error
   * where a real cancellation has none, so it earns no cancellation notice — and no failure row
   * either. The text it carries names the race between two requests, which is bookkeeping the
   * losing caller was already answered with; putting it in the transcript would be the chat
   * reporting an internal detail of the request that never became a turn.
   */
  it('shows neither a notice nor a failure row for a turn cancelled to release a claim', () => {
    const mapped = mapChatDetail(
      detailWith({
        turns: [turn('CANCELLED', { error: 'Released: another message claimed the chat' })],
      }),
    );

    expect(mapped.items).toEqual([]);
  });

  /**
   * What is on screen is measured in the unit the runtime capped it in, so a head full of
   * multi-byte characters is not mistaken for a result that was cut.
   */
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

  /** Tool calls appear under the prompt of the turn that produced them, in `seq` order. */
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

  /** Every persisted tool status has a transcript counterpart. */
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

  /** A tool call with no captured output still renders, with an empty body. */
  it('handles a tool call without output', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
        toolCalls: [{ ...toolCall({ id: 't1', seq: 1, toolName: 'run_shell' }), resultHead: null }],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', stdout: '', shownBytes: 0 });
  });

  /**
   * A tool name the schema does not know still renders, and the row says it cannot name the tool
   * rather than naming a different one. `run_shell` was the previous answer, and it is the reading
   * that does the damage: the row would then claim the model ran a shell command it never ran.
   */
  it('reports an unknown tool name as unknown instead of as a shell call', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [{ id: 'm1', turnId: null, seq: 1, role: 'USER', content: 'go', createdAt: AT }],
        toolCalls: [toolCall({ id: 't1', seq: 1, toolName: 'invented_tool' })],
      }),
    );
    expect(mapped.items[1]).toMatchObject({ kind: 'tool', name: null });
  });

  /** Every persisted turn status has a phase, and only live ones keep the stream open. */
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

  /** A chat with no turn yet is idle and follows nothing. */
  it('is idle without any turn', () => {
    const mapped = mapChatDetail(detailWith({}));
    expect(mapped.phase).toBe('idle');
    expect(mapped.activeTurnId).toBeNull();
    expect(mapped.startedAt).toBeNull();
  });

  /** A failed turn contributes an error row so the failure is visible in the transcript itself. */
  it('appends an error item for a failed turn', () => {
    const mapped = mapChatDetail(detailWith({ turns: [turn('FAILED', { error: 'boom' })] }));
    expect(mapped.items.at(-1)).toMatchObject({
      kind: 'error',
      message: 'boom',
      turnId: 'turn-1',
    });
  });

  /**
   * A chat that failed, was asked again and failed differently keeps both failures. Only the
   * newest turn's error used to survive a reload, so the transcript claimed the first attempt had
   * simply produced nothing — the one reading a reader cannot check, because the row that would
   * have contradicted it is the row that is missing.
   *
   * The rows are matched by the turn they name rather than by their position: what is being
   * asserted is that each failure is attributed to the turn it happened in.
   */
  it('keeps the failure of every failed turn, not only the newest', () => {
    const mapped = mapChatDetail(
      detailWith({
        turns: [
          {
            ...turn('FAILED', { error: 'first attempt: rate limited' }),
            id: 'turn-1',
            finishedAt: '2026-08-19T10:00:30.000Z',
          },
          {
            ...turn('FAILED', { error: 'second attempt: context too long' }),
            id: 'turn-2',
            queuedAt: '2026-08-19T10:01:00.000Z',
            finishedAt: '2026-08-19T10:01:30.000Z',
          },
        ],
      }),
    );

    expect(mapped.items.filter((item) => item.kind === 'error')).toEqual([
      expect.objectContaining({ turnId: 'turn-1', message: 'first attempt: rate limited' }),
      expect.objectContaining({ turnId: 'turn-2', message: 'second attempt: context too long' }),
    ]);
  });

  /**
   * A failure belongs where it happened, not at the end: the prompt that came after it has to read
   * as a reply to it. Appending every failure to the tail would put the first turn's error below
   * the second turn's prompt and invert the conversation.
   */
  it('places a failure row at the moment its turn finished', () => {
    const mapped = mapChatDetail(
      detailWith({
        messages: [
          {
            id: 'm1',
            turnId: null,
            seq: 1,
            role: 'USER',
            content: 'first',
            createdAt: '2026-08-19T10:00:00.000Z',
          },
          {
            id: 'm2',
            turnId: null,
            seq: 2,
            role: 'USER',
            content: 'second',
            createdAt: '2026-08-19T10:01:00.000Z',
          },
        ],
        turns: [
          {
            ...turn('FAILED', { error: 'rate limited' }),
            id: 'turn-1',
            finishedAt: '2026-08-19T10:00:30.000Z',
          },
        ],
      }),
    );

    expect(mapped.items.map((item) => item.kind)).toEqual(['user', 'error', 'user']);
  });

  /**
   * A retried turn that lost the race for the chat's work slot is recorded `FAILED` with the same
   * bookkeeping line, so this is the case the `FAILED`/`CANCELLED` split does not cover. Pinned so
   * the residual is a measured fact rather than something a later reader has to rediscover.
   */
  it('still shows the claim-release line of a turn recorded as failed', () => {
    const mapped = mapChatDetail(
      detailWith({
        turns: [turn('FAILED', { error: 'Released: another request claimed the chat' })],
      }),
    );

    expect(mapped.items).toEqual([expect.objectContaining({ kind: 'error', turnId: 'turn-1' })]);
  });

  /**
   * The runtime routes the whole result of a tool that cannot stream to stderr when the call
   * failed, so the live row carries a destructive left border. A reload put that same text on
   * stdout, which dropped the border and made a failed read look like a successful one that
   * happened to print an error message. The assertion is which stream the text landed on, not
   * whether the text is on screen — it was on screen the whole time.
   */
  it.each([
    ['FAILED', 'read_file'],
    ['TIMED_OUT', 'list_dir'],
  ] as const)('routes the head of a %s %s call to stderr', (status, toolName) => {
    const mapped = mapChatDetail(
      detailWith({
        toolCalls: [
          { ...toolCall({ id: 't1', seq: 0, toolName, status }), resultHead: 'no such file' },
        ],
      }),
    );

    expect(mapped.items[0]).toMatchObject({ stdout: '', stderr: 'no such file' });
  });

  /** A tool that cannot stream and succeeded reports on stdout, exactly as the live row did. */
  it('routes the head of a succeeded non-streaming call to stdout', () => {
    const mapped = mapChatDetail(
      detailWith({
        toolCalls: [{ ...toolCall({ id: 't1', seq: 0, toolName: 'read_file' }), resultHead: 'ok' }],
      }),
    );

    expect(mapped.items[0]).toMatchObject({ stdout: 'ok', stderr: '' });
  });

  /**
   * `run_shell` is the one tool whose output the runtime streams, so its head interleaves both of
   * the child's streams and no rule can split it back apart. It stays on stdout even when the call
   * failed, because that is the honest half of what is known — inventing a split would be the same
   * class of guess this whole path exists to remove.
   */
  it('leaves the head of a failed run_shell call on stdout', () => {
    const mapped = mapChatDetail(
      detailWith({
        toolCalls: [
          {
            ...toolCall({ id: 't1', seq: 0, toolName: 'run_shell', status: 'FAILED' }),
            resultHead: 'building…\nerror: exit 1\n',
          },
        ],
      }),
    );

    expect(mapped.items[0]).toMatchObject({
      stdout: 'building…\nerror: exit 1\n',
      stderr: '',
    });
  });

  /** The start time drives the elapsed timer in the header pill. */
  it('parses the turn start time', () => {
    const mapped = mapChatDetail(detailWith({ turns: [turn('RUNNING', { startedAt: AT })] }));
    expect(mapped.startedAt).toBe(Date.parse(AT));
  });

  /**
   * Everything else in a turn survives a reload; the preparation used to be the one thing that did
   * not, because it is an event and events are not kept. It is now recorded on the turn, and the
   * notice is spelled by the same builder the live stream uses so the two cannot say it
   * differently.
   */
  it('states again what each turn prepared, after a reload', () => {
    const turns = twoTurnTurns();
    const [first, second] = turns;
    const detail = twoTurnChat();
    const mapped = mapChatDetail({
      ...detail,
      turns: [
        { ...first!, preparedBranch: 'agent/aaa', preparedSha: '1111111abcdef' },
        { ...second!, preparedBranch: 'agent/bbb', preparedSha: '2222222abcdef' },
      ],
    });
    const notices = mapped.items.filter((item) => item.kind === 'notice');
    expect(notices.map((n) => n.text)).toEqual(
      expect.arrayContaining(['Prepared agent/aaa at 1111111', 'Prepared agent/bbb at 2222222']),
    );
  });

  /**
   * Two rules at once, and one id has to satisfy both. A reload of a live turn replays the stream
   * from its first event, so `prepare.done` arrives again and the reducer writes this same row —
   * the ids must agree or the reader is told it twice. And a chat keeps every turn it has run, so
   * the ids must differ per turn or a new preparation overwrites the last one instead of joining
   * it. A single shared constant satisfied the first and broke the second.
   */
  it('keys each notice on its turn, as the live reducer does', () => {
    const turns = twoTurnTurns();
    const [first, second] = turns;
    const detail = twoTurnChat();
    const mapped = mapChatDetail({
      ...detail,
      turns: [
        { ...first!, preparedBranch: 'agent/aaa', preparedSha: '1111111abcdef' },
        { ...second!, preparedBranch: 'agent/bbb', preparedSha: '2222222abcdef' },
      ],
    });
    const ids = mapped.items.filter((item) => item.kind === 'notice').map((n) => n.id);
    // One id per turn, and the same id the live reducer writes for that turn: they must agree so a
    // replay lands on top, and differ so a new turn's line does not erase the previous one's.
    expect(ids).toContain(prepareNoticeId('turn-1'));
    expect(ids).toContain(prepareNoticeId('turn-2'));
    expect(prepareNoticeId('turn-1')).not.toBe(prepareNoticeId('turn-2'));
  });

  /**
   * The mapper reads whatever the API returns, and `startedAt` is nullable there: a turn whose
   * start was never stamped still has a place in the order, and `queuedAt` is the instant that
   * always exists.
   */
  it('places the notice at the queued instant when no start was stamped', () => {
    const turns = twoTurnTurns();
    const [first] = turns;
    const detail = twoTurnChat();
    const mapped = mapChatDetail({
      ...detail,
      turns: [
        {
          ...first!,
          startedAt: null,
          preparedBranch: 'agent/aaa',
          preparedSha: '1111111abcdef',
        },
      ],
    });
    const notice = mapped.items.find(
      (item) => item.kind === 'notice' && item.text.startsWith('Prepared '),
    );
    expect(notice).toBeDefined();
  });

  /**
   * A turn that never got a workspace has nothing to state, and a line saying so would be a
   * sentence about something that did not happen.
   */
  it('says nothing about a turn that never reported a prepared workspace', () => {
    const mapped = mapChatDetail(twoTurnChat());
    const texts = mapped.items.filter((item) => item.kind === 'notice').map((n) => n.text);
    expect(texts.some((text) => text.startsWith('Prepared '))).toBe(false);
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
