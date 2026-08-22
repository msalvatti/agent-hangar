/**
 * Tests for the pure transcript reducer: every `AgentEvent` variant, id dedupe, and the terminal
 * helpers.
 */
import { agentEventSchema, prepareWarningText } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { AGENT_EVENT_TYPES, compareStreamIds, isTerminalPhase, transcriptReducer } from './reducer';
import type { ToolTranscriptItem, TranscriptState } from './types';
import { PREPARE_NOTICE_ID, TOOL_OUTPUT_DISPLAY_LIMIT_BYTES, createInitialState } from './types';

function dispatchEvent(
  state: TranscriptState,
  event: AgentEvent,
  options: { id?: string | null; now?: number } = {},
): TranscriptState {
  return transcriptReducer(state, {
    type: 'event',
    event,
    id: options.id ?? null,
    now: options.now ?? 0,
  });
}

describe('AGENT_EVENT_TYPES', () => {
  // Every variant the reducer switches on must be exercised without throwing, proving the switch
  // stays exhaustive as the protocol schema grows.
  it('is handled by the reducer for every discriminator value without throwing', () => {
    for (const type of AGENT_EVENT_TYPES) {
      const state = createInitialState();
      expect(() => dispatchEvent(state, minimalEventOf(type))).not.toThrow();
    }
  });

  // The list is derived from the schema, not hand-maintained, so it always has the right length.
  it('matches the schema option count', () => {
    expect(AGENT_EVENT_TYPES).toHaveLength(agentEventSchema.options.length);
  });
});

/** Builds the smallest valid event of a given discriminator, for the exhaustiveness sweep. */
function minimalEventOf(type: AgentEvent['type']): AgentEvent {
  switch (type) {
    case 'turn.started':
      return { type, turnId: 't1', at: '2026-01-01T00:00:00Z' };
    case 'prepare.progress':
      return { type, message: 'cloning' };
    case 'prepare.done':
      return { type, headSha: 'abc1234', branch: 'agent/x' };
    case 'step.started':
      return { type, step: 1 };
    case 'assistant.delta':
      return { type, text: 'hi' };
    case 'assistant.message':
      return { type, text: 'hi' };
    case 'tool.call':
      return { type, callId: 'c1', name: 'run_shell', args: {}, seq: 0 };
    case 'tool.output.delta':
      return { type, callId: 'c1', stream: 'stdout', text: 'x' };
    case 'tool.result':
      return { type, callId: 'c1', exitCode: 0, bytes: 0, durationMs: 0, status: 'SUCCEEDED' };
    case 'git.pushed':
      return { type, branch: 'agent/x', sha: 'abc1234' };
    case 'heartbeat':
      return { type, at: '2026-01-01T00:00:00Z' };
    case 'turn.completed':
      return { type, usage: { inputTokens: 0, outputTokens: 0 }, steps: 1, finalMessage: '' };
    case 'turn.failed':
      return { type, error: { code: 'E', message: 'boom' } };
    case 'turn.cancelled':
      return { type };
    case 'protocol.error':
      return { type, reason: 'invalid-json', length: 3 };
  }
}

describe('turn.started', () => {
  // Phase becomes "preparing" and startedAt is parsed from the ISO timestamp.
  it('sets phase to preparing and parses startedAt', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'turn.started',
      turnId: 't1',
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(state.phase).toBe('preparing');
    expect(state.startedAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});

describe('prepare.progress / prepare.done', () => {
  // The prepare notice is created on first progress and updated in place on further progress.
  it('upserts a single info notice across repeated progress events', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'prepare.progress',
      message: 'cloning',
    });
    state = dispatchEvent(state, { type: 'prepare.progress', message: 'checking out' });
    const notices = state.items.filter((item) => item.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id: PREPARE_NOTICE_ID, tone: 'info', text: 'checking out' });
  });

  // prepare.done rewrites the same notice as a success and switches the phase to running.
  it('rewrites the prepare notice to success and moves to running', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'turn.started',
      turnId: 't1',
      at: '1970-01-01T00:00:00.000Z',
    });
    state = dispatchEvent(state, { type: 'prepare.progress', message: 'cloning' });
    state = dispatchEvent(
      state,
      { type: 'prepare.done', headSha: 'abcdef1234', branch: 'agent/k3x9' },
      { now: 2_100 },
    );
    expect(state.phase).toBe('running');
    const notice = state.items.find((item) => item.kind === 'notice');
    expect(notice).toMatchObject({
      tone: 'success',
      text: 'Prepared agent/k3x9 at abcdef1',
      durationMs: 2_100,
    });
  });

  /**
   * The divergence warning preparation emits used to travel as ordinary progress, so it was
   * upserted into the one collapsing notice and `prepare.done` overwrote it with the success line
   * a few milliseconds later. The operator was told for about as long as it takes git to print a
   * sha. The assertion is that the finding is still an item after `prepare.done` — not that it was
   * ever rendered, which it always was.
   */
  it('keeps a preparation finding after prepare.done replaces the progress line', () => {
    const finding = prepareWarningText('agent/k3x9 and origin/agent/k3x9 have diverged');
    let state = dispatchEvent(createInitialState(), {
      type: 'prepare.progress',
      message: 'Resumed agent/k3x9 at abcdef1',
    });
    state = dispatchEvent(state, { type: 'prepare.progress', message: finding });
    state = dispatchEvent(state, {
      type: 'prepare.done',
      headSha: 'abcdef1234',
      branch: 'agent/k3x9',
    });

    expect(state.items).toEqual([
      expect.objectContaining({ kind: 'notice', id: PREPARE_NOTICE_ID, tone: 'success' }),
      expect.objectContaining({ kind: 'notice', tone: 'warning', text: finding }),
    ]);
  });

  /**
   * A client that reconnects is replayed the turn from its first event, so the same finding
   * arrives twice. One fact reported twice is still one fact — the same rule `git.pushed` follows.
   */
  it('reports a replayed preparation finding once', () => {
    const finding = prepareWarningText('origin/agent/k3x9 is 2 commits ahead of agent/k3x9');
    let state = dispatchEvent(createInitialState(), { type: 'prepare.progress', message: finding });
    state = dispatchEvent(state, { type: 'prepare.progress', message: finding });

    expect(state.items).toHaveLength(1);
  });

  /**
   * Two different findings are two different facts and each keeps its own line; only a repeat of
   * the same one collapses.
   */
  it('keeps a second, different preparation finding', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'prepare.progress',
      message: prepareWarningText('the branch diverged'),
    });
    state = dispatchEvent(state, {
      type: 'prepare.progress',
      message: prepareWarningText('HEAD moved since the last snapshot'),
    });

    expect(state.items).toHaveLength(2);
  });

  // Without a prior turn.started, startedAt is null and durationMs is omitted rather than NaN.
  it('omits durationMs when startedAt is unknown', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'prepare.done',
      headSha: 'abcdef1234',
      branch: 'agent/k3x9',
    });
    const notice = state.items.find((item) => item.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'success' });
    // The key is absent rather than present and empty: the row renders "took N ms" from its
    // presence, and a key carrying nothing would render an empty duration for every preparation
    // whose start nobody saw.
    expect(notice && 'durationMs' in notice).toBe(false);
  });

  /**
   * With a start recorded, the duration is how long the preparation took — the difference between
   * the two instants, in that order. Added instead, the row reports a preparation that began
   * before the epoch and took fifty-five years.
   */
  it('reports how long the preparation took', () => {
    let state = dispatchEvent(
      createInitialState(),
      { type: 'turn.started', turnId: 't1', at: new Date(1_000).toISOString() },
      { now: 1_000 },
    );
    state = dispatchEvent(
      state,
      { type: 'prepare.done', headSha: 'abcdef1234', branch: 'agent/k3x9' },
      { now: 4_500 },
    );

    const notice = state.items.find((item) => item.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'success', durationMs: 3_500 });
  });
});

describe('step.started', () => {
  // The step counter is stored verbatim.
  it('sets the step counter', () => {
    const state = dispatchEvent(createInitialState(), { type: 'step.started', step: 3 });
    expect(state.step).toBe(3);
  });
});

describe('assistant.delta / assistant.message', () => {
  // The first delta creates a new streaming assistant item.
  it('opens a tool row keyed by the call it belongs to', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'tool.call',
      callId: 'c9',
      name: 'run_shell',
      args: { command: 'ls' },
      seq: 0,
    });

    expect(state.items[0]).toMatchObject({ kind: 'tool', id: 'tool-c9', callId: 'c9' });
  });

  it('creates a streaming assistant item on the first delta', () => {
    const state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'Hello' });
    expect(state.items).toEqual([
      { kind: 'assistant', id: 'assistant-0-0', text: 'Hello', streaming: true },
    ]);
    expect(state.phase).toBe('running');
  });

  // Subsequent deltas append to the same streaming item rather than creating new ones.
  it('appends subsequent deltas to the streaming item', () => {
    let state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'Hel' });
    state = dispatchEvent(state, { type: 'assistant.delta', text: 'lo' });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Hello', streaming: true });
    // Text arriving is the turn running, whether or not it is the first of it: the phase is what
    // the page shows as a spinner, and a transcript that stayed on the preparing phase while the
    // model was answering would show one for the whole turn.
    expect(state.phase).toBe('running');
  });

  // assistant.message finalizes an in-progress stream with the authoritative final text.
  it('finalizes a streaming item on assistant.message', () => {
    let state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'Hel' });
    state = dispatchEvent(state, { type: 'assistant.message', text: 'Hello there' });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Hello there', streaming: false });
  });

  // assistant.message with no prior streaming item pushes an already-finalized item.
  it('pushes a finalized item when no streaming item exists', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'assistant.message',
      text: 'Direct answer',
    });
    expect(state.items).toEqual([
      { kind: 'assistant', id: 'assistant-0-0', text: 'Direct answer', streaming: false },
    ]);
  });
});

describe('tool.call / tool.output.delta / tool.result', () => {
  // tool.call finalizes any in-flight streaming assistant text before opening the tool row.
  it('finalizes a streaming assistant item before the tool row', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'assistant.delta',
      text: 'Looking...',
    });
    state = dispatchEvent(state, {
      type: 'tool.call',
      callId: 'c1',
      name: 'run_shell',
      args: { cmd: 'ls' },
      seq: 0,
    });
    expect(state.items[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(state.items[1]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'running' });
  });

  // Deltas append to the right stream (stdout/stderr) of the matching call.
  it('appends stdout and stderr deltas independently', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'tool.call',
      callId: 'c1',
      name: 'run_shell',
      args: {},
      seq: 0,
    });
    state = dispatchEvent(state, {
      type: 'tool.output.delta',
      callId: 'c1',
      stream: 'stdout',
      text: 'out',
    });
    state = dispatchEvent(state, {
      type: 'tool.output.delta',
      callId: 'c1',
      stream: 'stderr',
      text: 'err',
    });
    const tool = state.items.find((item) => item.kind === 'tool')!;
    expect(tool.stdout).toBe('out');
    expect(tool.stderr).toBe('err');
    expect(tool.shownBytes).toBe(6);
  });

  // A delta for an unknown callId is ignored rather than throwing or creating a row.
  it('ignores a delta for an unknown callId', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'tool.output.delta',
      callId: 'ghost',
      stream: 'stdout',
      text: 'x',
    });
    expect(state.items).toHaveLength(0);
  });

  // Output is capped at TOOL_OUTPUT_DISPLAY_LIMIT_BYTES, truncating a delta that straddles it.
  it('caps shown output at the display limit, truncating a straddling delta', () => {
    const nearCap: ToolTranscriptItem = {
      kind: 'tool',
      id: 'tool-c1',
      callId: 'c1',
      name: 'run_shell',
      args: {},
      seq: 0,
      status: 'running',
      stdout: '',
      stderr: '',
      shownBytes: TOOL_OUTPUT_DISPLAY_LIMIT_BYTES - 5,
      totalBytes: null,
      exitCode: null,
      durationMs: null,
      startedAt: 0,
    };
    let state: TranscriptState = { ...createInitialState(), items: [nearCap] };
    state = dispatchEvent(state, {
      type: 'tool.output.delta',
      callId: 'c1',
      stream: 'stdout',
      text: 'aaaaaaaaaa',
    });
    const tool = state.items[0] as ToolTranscriptItem;
    expect(tool.shownBytes).toBe(TOOL_OUTPUT_DISPLAY_LIMIT_BYTES);
    expect(tool.stdout).toBe('aaaaa');

    // A further delta once the cap is already reached changes nothing.
    const capped = dispatchEvent(state, {
      type: 'tool.output.delta',
      callId: 'c1',
      stream: 'stdout',
      text: 'more',
    });
    expect((capped.items[0] as ToolTranscriptItem).stdout).toBe('aaaaa');
    expect((capped.items[0] as ToolTranscriptItem).shownBytes).toBe(
      TOOL_OUTPUT_DISPLAY_LIMIT_BYTES,
    );
  });

  // Cutting the encoded delta at a byte boundary can split a multibyte character. Decoding that
  // partial sequence one-shot substitutes U+FFFD, which is three bytes — more than the fragment it
  // replaced — so the row would end up over the cap it was truncated to respect.
  it('never exceeds the display limit when the cut splits a multibyte character', () => {
    const nearCap: ToolTranscriptItem = {
      kind: 'tool',
      id: 'tool-c1',
      callId: 'c1',
      name: 'run_shell',
      args: {},
      seq: 0,
      status: 'running',
      stdout: '',
      stderr: '',
      shownBytes: TOOL_OUTPUT_DISPLAY_LIMIT_BYTES - 3,
      totalBytes: null,
      exitCode: null,
      durationMs: null,
      startedAt: 0,
    };
    let state: TranscriptState = { ...createInitialState(), items: [nearCap] };
    // 'a' is one byte and 'é' is two, so a three-byte budget ends inside the first 'é'.
    state = dispatchEvent(state, {
      type: 'tool.output.delta',
      callId: 'c1',
      stream: 'stdout',
      text: 'aaéé',
    });
    const tool = state.items[0] as ToolTranscriptItem;
    expect(tool.stdout).toBe('aa');
    expect(tool.stdout).not.toContain('\uFFFD');
    expect(tool.shownBytes).toBeLessThanOrEqual(TOOL_OUTPUT_DISPLAY_LIMIT_BYTES);
  });

  // tool.result records status/exitCode/durationMs/totalBytes for each terminal status.
  it.each([
    ['SUCCEEDED', 'succeeded'],
    ['FAILED', 'failed'],
    ['TIMED_OUT', 'timed_out'],
  ] as const)('maps tool.result status %s to %s', (serverStatus, displayStatus) => {
    let state = dispatchEvent(createInitialState(), {
      type: 'tool.call',
      callId: 'c1',
      name: 'run_shell',
      args: {},
      seq: 0,
    });
    state = dispatchEvent(state, {
      type: 'tool.result',
      callId: 'c1',
      exitCode: serverStatus === 'SUCCEEDED' ? 0 : 1,
      bytes: 42,
      durationMs: 300,
      status: serverStatus,
    });
    const tool = state.items[0] as ToolTranscriptItem;
    expect(tool.status).toBe(displayStatus);
    expect(tool.totalBytes).toBe(42);
    expect(tool.durationMs).toBe(300);
  });

  /**
   * A result for a callId this client never folded in. It is reachable: the turn event stream is
   * capped at `TURN_EVENTS_MAXLEN`, so a chatty long-running call plus a reconnect can deliver a
   * terminal event whose opening frame has already been trimmed away.
   *
   * The row appears, because the call happened and its outcome is known. What it must not do is
   * fill in the fields the opening frame carried: it used to hardcode `run_shell` and `{}`, which
   * is a row asserting that the model ran a shell command with no arguments — a statement nothing
   * measured, indistinguishable on screen from a real one, and reported as a defect three times.
   */
  it('opens a row that admits it never saw the call, instead of naming run_shell', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'tool.result',
      callId: 'ghost',
      exitCode: 0,
      bytes: 10,
      durationMs: 5,
      status: 'SUCCEEDED',
    });

    const tool = state.items[0] as ToolTranscriptItem;
    // The row is keyed by the call it belongs to. React lists these by `id`, and a row keyed by
    // nothing collides with every other row that has no key of its own.
    expect(tool).toMatchObject({
      kind: 'tool',
      id: 'tool-ghost',
      callId: 'ghost',
      status: 'succeeded',
      // Nothing was streamed for a call this transcript never saw open, and the row says so with
      // empty output rather than with text nobody produced.
      stdout: '',
      stderr: '',
    });
    expect(tool.name).toBeNull();
    expect(tool.seq).toBeNull();
    expect(tool.args).toBeUndefined();
    expect('args' in tool).toBe(true);
  });

  /**
   * The one field the orphan row may state is `startedAt`, and it is not a guess: the result
   * carries how long the call took, so the instant it began follows from the instant it ended.
   */
  it('derives the start of an orphan row from the duration the result reports', () => {
    const state = dispatchEvent(
      createInitialState(),
      {
        type: 'tool.result',
        callId: 'ghost',
        exitCode: null,
        bytes: 0,
        durationMs: 4_000,
        status: 'FAILED',
      },
      { now: 10_000 },
    );

    expect((state.items[0] as ToolTranscriptItem).startedAt).toBe(6_000);
  });

  /**
   * The honest row is only for a call this client never saw. A call it did see keeps everything
   * the opening frame carried, which is what stops the repair from erasing the ordinary case.
   */
  it('keeps the name and arguments of a call whose opening frame did arrive', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'tool.call',
      callId: 'c1',
      name: 'read_file',
      args: { path: 'src/index.ts' },
      seq: 3,
    });
    state = dispatchEvent(state, {
      type: 'tool.result',
      callId: 'c1',
      exitCode: null,
      bytes: 10,
      durationMs: 5,
      status: 'FAILED',
    });

    expect(state.items[0]).toMatchObject({
      name: 'read_file',
      args: { path: 'src/index.ts' },
      seq: 3,
    });
  });
});

describe('git.pushed', () => {
  // A success notice is appended, keyed by SHA so multiple pushes each get their own row.
  it('appends a success notice with the short SHA', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'git.pushed',
      branch: 'agent/k3x9',
      sha: 'abcdef1234',
    });
    expect(state.items).toEqual([
      {
        kind: 'notice',
        id: 'git-abcdef1234',
        tone: 'success',
        text: 'Pushed agent/k3x9 @ abcdef1',
      },
    ]);
  });
});

describe('heartbeat', () => {
  // A heartbeat updates only lastActivityAt (via the dedupe path); it changes nothing else.
  it('does not change items or phase', () => {
    const before = createInitialState();
    const after = dispatchEvent(
      before,
      { type: 'heartbeat', at: '2026-01-01T00:00:00Z' },
      { now: 500 },
    );
    expect(after.items).toEqual(before.items);
    expect(after.phase).toBe(before.phase);
    expect(after.lastActivityAt).toBe(500);
  });
});

describe('turn.completed', () => {
  // A streaming item is finalized, and a distinct finalMessage is pushed as its own item.
  it('finalizes streaming text and appends a distinct finalMessage', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'assistant.delta',
      text: 'Working...',
    });
    state = dispatchEvent(state, {
      type: 'turn.completed',
      usage: { inputTokens: 10, outputTokens: 20 },
      steps: 2,
      finalMessage: 'Done, fixed the bug.',
    });
    expect(state.phase).toBe('succeeded');
    expect(state.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ text: 'Working...', streaming: false });
    // The appended answer is keyed by the step it belongs to and its place in the list. React
    // lists these by `id`, and two items sharing one key are two rows React treats as one.
    expect(state.items[1]).toMatchObject({
      id: 'assistant-0-1',
      text: 'Done, fixed the bug.',
      streaming: false,
    });
  });

  // When the streaming item's text already equals finalMessage, no duplicate is pushed.
  it('does not duplicate a finalMessage already present', () => {
    let state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'Same text' });
    state = dispatchEvent(state, {
      type: 'turn.completed',
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: 1,
      finalMessage: 'Same text',
    });
    expect(state.items).toHaveLength(1);
  });

  // A final message with no assistant text before it is still the answer, so it becomes the only
  // item. Read the other way round — "every item already says this" is vacuously true of an empty
  // transcript — a turn that streamed nothing would end with nothing to show.
  it('appends the final message when nothing was streamed', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'turn.completed',
      usage: { inputTokens: 1, outputTokens: 1 },
      steps: 1,
      finalMessage: 'Done.',
    });

    expect(state.items).toEqual([
      { kind: 'assistant', id: 'assistant-0-0', text: 'Done.', streaming: false },
    ]);
  });

  // Only the assistant's own text counts as "already said". A notice carries text too — the
  // preparation line, a push, a cancellation — and matching against one would swallow an answer
  // whose wording happens to coincide with something the transcript had already announced.
  it('appends a final message that a notice happens to repeat', () => {
    let state = dispatchEvent(createInitialState(), {
      type: 'prepare.progress',
      message: 'Cloning the repository',
    });
    state = dispatchEvent(state, {
      type: 'turn.completed',
      usage: { inputTokens: 1, outputTokens: 1 },
      steps: 1,
      finalMessage: 'Cloning the repository',
    });

    expect(state.items.filter((item) => item.kind === 'assistant')).toEqual([
      { kind: 'assistant', id: 'assistant-0-1', text: 'Cloning the repository', streaming: false },
    ]);
  });

  // An empty finalMessage never becomes its own item.
  it('does not push an empty finalMessage', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'turn.completed',
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: 0,
      finalMessage: '',
    });
    expect(state.items).toHaveLength(0);
  });

  // stoppedBy: 'limit' both records the reason and surfaces a warning notice.
  it('records stoppedBy and adds a limit-reached notice', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'turn.completed',
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: 40,
      finalMessage: '',
      stoppedBy: 'limit',
    });
    expect(state.stoppedBy).toBe('limit');
    expect(state.items).toEqual([
      {
        kind: 'notice',
        id: 'limit-0',
        tone: 'warning',
        text: 'Stopped early: step or time limit reached.',
      },
    ]);
  });

  // finishedAt comes from the action's clock, not a wall-clock read inside the reducer.
  it('sets finishedAt from the action clock', () => {
    const state = dispatchEvent(
      createInitialState(),
      {
        type: 'turn.completed',
        usage: { inputTokens: 0, outputTokens: 0 },
        steps: 1,
        finalMessage: '',
      },
      { now: 9_999 },
    );
    expect(state.finishedAt).toBe(9_999);
  });
});

describe('turn.failed', () => {
  // Phase becomes failed, the error is recorded, and an error item is appended.
  it('records the error and appends an error item', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'turn.failed',
      error: { code: 'WORKSPACE_IMAGE_MISSING', message: 'image not found' },
    });
    expect(state.phase).toBe('failed');
    expect(state.error).toEqual({ code: 'WORKSPACE_IMAGE_MISSING', message: 'image not found' });
    expect(state.items).toEqual([
      { kind: 'error', id: 'error-0', code: 'WORKSPACE_IMAGE_MISSING', message: 'image not found' },
    ]);
  });

  // A turn that fails mid-stream must not leave its assistant bubble stuck in streaming state
  // (it will never receive another delta once the turn is terminal).
  it('finalizes a streaming assistant item before the error item', () => {
    let state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'partial' });
    state = dispatchEvent(state, { type: 'turn.failed', error: { code: 'E', message: 'boom' } });
    expect(state.items[0]).toMatchObject({ kind: 'assistant', text: 'partial', streaming: false });
    expect(state.items[1]).toMatchObject({ kind: 'error', code: 'E' });
  });
});

describe('turn.cancelled', () => {
  // Phase becomes cancelled, streaming text is finalized, and a warning notice is appended.
  it('finalizes streaming text and appends a cancellation notice', () => {
    let state = dispatchEvent(createInitialState(), { type: 'assistant.delta', text: 'partial' });
    state = dispatchEvent(state, { type: 'turn.cancelled' });
    expect(state.phase).toBe('cancelled');
    expect(state.items[0]).toMatchObject({ streaming: false });
    expect(state.items[1]).toMatchObject({
      kind: 'notice',
      id: 'cancel-0',
      tone: 'warning',
      text: 'Turn cancelled.',
    });
  });
});

describe('protocol.error', () => {
  // A malformed line never throws; it becomes a quiet warning notice instead.
  it('appends a warning notice and never throws', () => {
    const state = dispatchEvent(createInitialState(), {
      type: 'protocol.error',
      reason: 'invalid-json',
      length: 12,
    });
    expect(state.items).toEqual([
      { kind: 'notice', id: 'protocol-error-0', tone: 'warning', text: 'Malformed event skipped.' },
    ]);
  });
});

describe('connection action', () => {
  // Every ConnectionState value, including the SSE "expired" frame, is applied verbatim.
  it.each(['idle', 'connecting', 'open', 'reconnecting', 'expired', 'closed'] as const)(
    'sets connection to %s',
    (connection) => {
      const state = transcriptReducer(createInitialState(), { type: 'connection', connection });
      expect(state.connection).toBe(connection);
    },
  );
});

describe('reset action', () => {
  // Replaces items/phase and clears error/usage/stoppedBy, but keeps lastEventId.
  it('replaces items and phase, clears derived turn state, keeps lastEventId', () => {
    let state = dispatchEvent(
      createInitialState(),
      { type: 'turn.failed', error: { code: 'E', message: 'm' } },
      { id: '5-0' },
    );
    state = transcriptReducer(state, { type: 'reset', items: [], phase: 'idle' });
    expect(state.items).toEqual([]);
    expect(state.phase).toBe('idle');
    expect(state.error).toBeNull();
    expect(state.usage).toBeNull();
    expect(state.stoppedBy).toBeNull();
    expect(state.lastEventId).toBe('5-0');
  });
});

describe('id dedupe', () => {
  // A replayed id (same or older than lastEventId) is dropped without changing state.
  it('drops an event whose id is not newer than lastEventId', () => {
    let state = dispatchEvent(
      createInitialState(),
      { type: 'step.started', step: 1 },
      { id: '1700000000000-1' },
    );
    const before = state;
    state = dispatchEvent(state, { type: 'step.started', step: 2 }, { id: '1700000000000-0' });
    expect(state).toBe(before);
    expect(state.step).toBe(1);

    // The same id is a replay too, not merely an older one: a reconnect resumes *after* the last
    // id it saw, and a stream that redelivered it would apply that event twice.
    state = dispatchEvent(state, { type: 'step.started', step: 3 }, { id: '1700000000000-1' });
    expect(state).toBe(before);
    expect(state.step).toBe(1);
  });

  // A newer id (same millisecond, next sequence) is applied.
  it('applies an event whose sequence advances within the same millisecond', () => {
    let state = dispatchEvent(
      createInitialState(),
      { type: 'step.started', step: 1 },
      { id: '1700000000000-0' },
    );
    state = dispatchEvent(state, { type: 'step.started', step: 2 }, { id: '1700000000000-1' });
    expect(state.step).toBe(2);
    expect(state.lastEventId).toBe('1700000000000-1');
  });

  // A null id (synthetic events, e.g. from the hook's own protocol.error) is never deduped.
  it('never dedupes a null id', () => {
    let state = dispatchEvent(
      createInitialState(),
      { type: 'step.started', step: 1 },
      { id: '1700000000000-0' },
    );
    state = dispatchEvent(state, { type: 'step.started', step: 2 }, { id: null });
    expect(state.step).toBe(2);
    expect(state.lastEventId).toBe('1700000000000-0');
  });
});

describe('compareStreamIds', () => {
  // Numeric comparison table over well-formed "<ms>-<seq>" ids.
  it.each([
    ['1700000000000-0', '1700000000000-1', -1],
    ['1700000000000-1', '1700000000000-0', 1],
    ['1700000000000-0', '1700000000000-0', 0],
    ['1700000000001-0', '1700000000000-9', 1],
    ['1700000000000-9', '1700000000001-0', -1],
  ])('compareStreamIds(%s, %s) has sign %i', (a, b, expectedSign) => {
    expect(Math.sign(compareStreamIds(a, b))).toBe(expectedSign);
  });

  // Malformed ids (not "<digits>-<digits>") fall back to a plain string comparison.
  it('falls back to string comparison for malformed ids', () => {
    expect(compareStreamIds('abc', 'abd')).toBeLessThan(0);
    expect(compareStreamIds('abc', 'abc')).toBe(0);
    expect(compareStreamIds('abd', 'abc')).toBeGreaterThan(0);
  });

  // One id well-formed and the other not is still the string fallback: reading the numbers out of
  // a match that is not there is what a comparison of a real id against a synthetic one would do.
  it('falls back when only one id is well formed', () => {
    expect(() => compareStreamIds('1700000000000-0', 'abc')).not.toThrow();
    expect(compareStreamIds('1700000000000-0', 'abc')).toBeLessThan(0);
    expect(compareStreamIds('abc', '1700000000000-0')).toBeGreaterThan(0);
  });

  // The pattern reads the whole id and nothing less. An id with anything before or after it is not
  // a Redis entry id, and treating its digits as one would order it among ids it has no place in.
  it.each([
    ['x1700000000000-0', '1700000000000-0'],
    ['1700000000000-0x', '1700000000000-0'],
  ])('treats %s as malformed beside %s', (malformed, wellFormed) => {
    // The string fallback puts the malformed one after, which the numeric branch would not.
    expect(compareStreamIds(malformed, wellFormed)).toBeGreaterThan(0);
  });
});

describe('isTerminalPhase', () => {
  // Only succeeded/failed/cancelled are terminal; every other phase is not.
  it.each([
    ['idle', false],
    ['queued', false],
    ['preparing', false],
    ['running', false],
    ['succeeded', true],
    ['failed', true],
    ['cancelled', true],
  ] as const)('isTerminalPhase(%s) is %s', (phase, expected) => {
    expect(isTerminalPhase(phase)).toBe(expected);
  });
});
