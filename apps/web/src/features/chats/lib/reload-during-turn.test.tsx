/**
 * A live turn whose transcript is rebuilt from the database underneath it.
 *
 * Layer: unit (scenario).
 * Goal: one property, reached from both directions. A row means the same thing whether it came
 * from the stream or from persistence, so rebuilding the transcript mid-turn neither doubles what
 * the stream already delivered — a reload replays the turn from its first event — nor discards
 * what it delivered, which is what a rebuild after the operator presses Stop does. Asserted on
 * what is rendered, because both failures are rows the reader sees.
 * Mocks: none — the persisted payload and the streamed events are both written out as the API and
 * the runtime produce them.
 */
import type { AgentEvent, ChatDetail, MessageView, ToolCallView } from '@agent-hangar/core';
import { pushedNoticeText } from '@agent-hangar/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Transcript, createInitialState, transcriptReducer } from '@/shared/transcript';
import type { TranscriptState } from '@/shared/transcript';

import { mapChatDetail } from './map-chat-detail';

/** Branch the turn pushed to. */
const BRANCH = 'agent/1a2b3c4d';

/** Commit it pushed. */
const SHA = '9f8e7d6c5b4a39281706';

/** Instant the reload happens, for the reducer's clock. */
const RELOADED_AT = Date.parse('2026-08-19T10:02:00.000Z');

/**
 * The messages that turn has written: the prompt that started it, and the push it reported.
 *
 * The prompt names no turn, which is what the schema produces; the push notice does, because the
 * worker writes it once the turn is already running.
 *
 * @returns The chat's messages.
 */
function runningTurnMessages(): MessageView[] {
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
      content: pushedNoticeText(BRANCH, SHA),
      createdAt: '2026-08-19T10:00:40.000Z',
    },
  ];
}

/**
 * The two calls the turn has recorded: one finished, one still going.
 *
 * @returns The tool-call rows, in `seq` order.
 */
function runningTurnCalls(): ToolCallView[] {
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
      startedAt: '2026-08-19T10:00:20.000Z',
      finishedAt: '2026-08-19T10:00:20.080Z',
      durationMs: 80,
    },
    {
      id: 't2',
      turnId: 'turn-1',
      jobRunId: null,
      callId: 'call-2',
      seq: 1,
      toolName: 'run_shell',
      args: { command: 'pnpm test' },
      resultHead: null,
      resultBytes: null,
      exitCode: null,
      status: 'RUNNING',
      startedAt: '2026-08-19T10:01:00.000Z',
      finishedAt: null,
      durationMs: null,
    },
  ];
}

/**
 * The payload of a chat whose newest turn is still running.
 *
 * @returns The `GET /api/chats/:id` payload.
 */
function runningTurnChat(): ChatDetail {
  return {
    chat: {
      id: 'chat-1',
      title: 'Rename the retry helper',
      status: 'ACTIVE',
      repoUrl: 'https://github.com/acme/api',
      baseBranch: 'main',
      workBranch: BRANCH,
      lastPushedSha: SHA,
      createdAt: '2026-08-19T10:00:00.000Z',
      updatedAt: '2026-08-19T10:01:00.000Z',
      archivedAt: null,
      lastTurnStatus: 'RUNNING',
    },
    messages: runningTurnMessages(),
    turns: [
      {
        id: 'turn-1',
        status: 'RUNNING',
        model: 'gpt-5.6-sol',
        workspaceId: 'workspace-1',
        usage: { inputTokens: null, outputTokens: null, stepCount: 2 },
        error: null,
        queuedAt: '2026-08-19T10:00:00.100Z',
        startedAt: '2026-08-19T10:00:02.000Z',
        finishedAt: null,
      },
    ],
    toolCalls: runningTurnCalls(),
    workspace: null,
  };
}

/**
 * The events the server replays for that turn when the page reopens the stream, which it does from
 * the first entry because the client has no resume point to offer.
 *
 * @returns The replayed events, oldest first.
 */
function replayedTurn(): AgentEvent[] {
  return [
    { type: 'turn.started', turnId: 'turn-1', at: '2026-08-19T10:00:02.000Z' },
    { type: 'prepare.progress', message: 'Cloning…' },
    { type: 'prepare.done', headSha: SHA, branch: BRANCH },
    { type: 'step.started', step: 1 },
    { type: 'tool.call', callId: 'call-1', name: 'list_dir', args: { path: 'src' }, seq: 1 },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'retry.ts\nindex.ts\n' },
    {
      type: 'tool.result',
      callId: 'call-1',
      exitCode: null,
      bytes: 18,
      durationMs: 80,
      status: 'SUCCEEDED',
    },
    { type: 'git.pushed', branch: BRANCH, sha: SHA },
    { type: 'step.started', step: 2 },
    {
      type: 'tool.call',
      callId: 'call-2',
      name: 'run_shell',
      args: { command: 'pnpm test' },
      seq: 2,
    },
  ];
}

/**
 * Folds a replay into a state seeded from the persisted transcript, the way a reloaded page does.
 *
 * @param detail - The persisted chat.
 * @param events - The events the stream replays.
 * @returns The state the transcript renders from.
 */
function reloadThenReplay(detail: ChatDetail, events: readonly AgentEvent[]): TranscriptState {
  const mapped = mapChatDetail(detail);
  let state = createInitialState({ items: mapped.items, phase: mapped.phase });
  for (const [index, event] of events.entries()) {
    state = transcriptReducer(state, {
      type: 'event',
      event,
      id: `${String(RELOADED_AT)}-${String(index)}`,
      now: RELOADED_AT,
    });
  }
  return state;
}

describe('reloading a chat mid-turn', () => {
  /**
   * The seed is what makes the reload worth doing, so this pins the precondition the rest of the
   * file depends on: the turn is still live, which is what opens the stream that replays it.
   */
  it('seeds the running turn and keeps following it', () => {
    const mapped = mapChatDetail(runningTurnChat());

    expect(mapped.activeTurnId).toBe('turn-1');
    expect(mapped.items.filter((item) => item.kind === 'tool')).toHaveLength(2);
  });

  /**
   * Each call the turn made is one row after the replay, not two. The call id is the same on both
   * roads — the worker stores the one the runtime issued — so a replayed call the transcript
   * already holds is that same call arriving again.
   */
  it('renders one row per tool call after the replay', () => {
    const state = reloadThenReplay(runningTurnChat(), replayedTurn());

    render(<Transcript items={state.items} phase={state.phase} />);

    expect(document.querySelectorAll('[data-item-kind="tool"]')).toHaveLength(2);
    expect(screen.getAllByText('list_dir')).toHaveLength(1);
    expect(screen.getAllByText('run_shell')).toHaveLength(1);
  });

  /**
   * The push is stored as a `SYSTEM` message and replayed as a `git.pushed` event, and the two
   * carry different ids — the message's own, and one built from the sha — so only the fact they
   * both state can tell the reader they are the same push.
   */
  it('renders the push notice once after the replay', () => {
    const state = reloadThenReplay(runningTurnChat(), replayedTurn());

    render(<Transcript items={state.items} phase={state.phase} />);

    expect(screen.getAllByText(pushedNoticeText(BRANCH, SHA))).toHaveLength(1);
  });

  /**
   * The outcome the replay carries still lands on the row: the finished call keeps its exit
   * status and the one still running keeps the start time persistence recorded, rather than
   * restarting its clock at the moment of the reload.
   */
  it(`keeps each row's own outcome and start time`, () => {
    const state = reloadThenReplay(runningTurnChat(), replayedTurn());
    const tools = state.items.filter((item) => item.kind === 'tool');

    expect(tools[0]).toMatchObject({ callId: 'call-1', status: 'succeeded', durationMs: 80 });
    expect(tools[1]).toMatchObject({
      callId: 'call-2',
      status: 'running',
      startedAt: Date.parse('2026-08-19T10:01:00.000Z'),
    });
  });

  /**
   * The dedupe is about a row arriving twice, not about collapsing the work: a second call the
   * seed never saw is still added.
   */
  it('adds a call the seed did not carry', () => {
    const state = reloadThenReplay(runningTurnChat(), [
      ...replayedTurn(),
      {
        type: 'tool.call',
        callId: 'call-3',
        name: 'read_file',
        args: { path: 'src/retry.ts' },
        seq: 3,
      },
    ]);

    render(<Transcript items={state.items} phase={state.phase} />);

    expect(document.querySelectorAll('[data-item-kind="tool"]')).toHaveLength(3);
    expect(screen.getAllByText('read_file')).toHaveLength(1);
  });

  /**
   * A second push, to a commit the seed does not name, is a different fact and gets its own line.
   */
  it('adds a push the seed did not carry', () => {
    const state = reloadThenReplay(runningTurnChat(), [
      ...replayedTurn(),
      { type: 'git.pushed', branch: BRANCH, sha: 'c0ffee1234567890' },
    ]);

    render(<Transcript items={state.items} phase={state.phase} />);

    expect(screen.getAllByText(pushedNoticeText(BRANCH, SHA))).toHaveLength(1);
    expect(screen.getAllByText(pushedNoticeText(BRANCH, 'c0ffee1234567890'))).toHaveLength(1);
  });
});

describe('rebuilding a chat transcript while its turn is still live', () => {
  /**
   * What a Stop does to the page: the request invalidates the chat, the refetch remaps it, and the
   * reducer is reseeded from persistence while the stream is still open. The row on screen is
   * replaced by the row the database holds, and both carry the same call, so the command survives
   * that swap instead of being replaced by an empty one.
   */
  it('keeps the running call and its arguments across a reseed', () => {
    const streamed = replayedTurn().reduce<TranscriptState>(
      (state, event, index) =>
        transcriptReducer(state, {
          type: 'event',
          event,
          id: `${String(RELOADED_AT)}-${String(index)}`,
          now: RELOADED_AT,
        }),
      createInitialState(),
    );
    expect(streamed.items.filter((item) => item.kind === 'tool')).toHaveLength(2);

    const mapped = mapChatDetail(runningTurnChat());
    const reseeded = transcriptReducer(streamed, {
      type: 'reset',
      items: mapped.items,
      phase: mapped.phase,
    });

    render(<Transcript items={reseeded.items} phase={reseeded.phase} />);

    expect(document.querySelectorAll('[data-item-kind="tool"]')).toHaveLength(2);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });

  /**
   * The result that lands after the reseed finds the row the reseed put there, rather than
   * inventing one beside it. A command killed by a signal reports no exit code, so the row shows
   * how long it ran and does not print the word in front of a blank.
   */
  it('folds the result that arrives after the reseed into that same row', () => {
    const mapped = mapChatDetail(runningTurnChat());
    const reseeded = transcriptReducer(createInitialState(), {
      type: 'reset',
      items: mapped.items,
      phase: mapped.phase,
    });
    const settled = transcriptReducer(reseeded, {
      type: 'event',
      event: {
        type: 'tool.result',
        callId: 'call-2',
        exitCode: null,
        bytes: 16,
        durationMs: 17_300,
        status: 'FAILED',
      },
      id: `${String(RELOADED_AT)}-99`,
      now: RELOADED_AT,
    });

    render(<Transcript items={settled.items} phase={settled.phase} />);

    expect(document.querySelectorAll('[data-item-kind="tool"]')).toHaveLength(2);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('17.3 s')).toBeInTheDocument();
    expect(screen.queryByText(/exit/)).toBeNull();
  });
});
