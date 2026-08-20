/**
 * Unit tests for the tool-call recorder.
 *
 * Layer: unit.
 * Goal: rows carry the run they belong to, the output head is bounded in bytes without cutting a
 * character in half, summaries follow the agent's own order and cover only finished calls, and an
 * event for a call nobody started is reported rather than crashing the turn.
 * Mocks: `createTestContainer`'s in-memory repositories.
 */
import type { AgentEventOf } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { createTestContainer } from '../testing/index.js';

import { TOOL_OUTPUT_HEAD_BYTES } from './constants.js';
import { appendWithinBudget, createToolCallRecorder } from './tool-call-recorder.js';

/** Builds a `tool.call` event. */
function call(callId: string, seq: number): AgentEventOf<'tool.call'> {
  return { type: 'tool.call', callId, name: 'run_shell', args: { command: 'ls' }, seq };
}

/** Builds a `tool.result` event. */
function result(callId: string): AgentEventOf<'tool.result'> {
  return {
    type: 'tool.result',
    callId,
    exitCode: 0,
    bytes: 4,
    durationMs: 1500,
    status: 'SUCCEEDED',
  };
}

describe('appendWithinBudget', () => {
  /**
   * Below the budget everything is kept.
   */
  it('keeps a chunk that fits', () => {
    expect(appendWithinBudget('ab', 'cd', 10)).toBe('abcd');
  });

  /**
   * At the budget nothing more is kept, and the head is not rebuilt.
   */
  it('keeps nothing once the budget is spent', () => {
    expect(appendWithinBudget('abcdef', 'gh', 6)).toBe('abcdef');
  });

  /**
   * A chunk that overflows is cut on a character boundary: cutting the byte array would write a
   * replacement character into the transcript, and this text is shown to the user.
   */
  it('cuts an overflowing chunk on a character boundary', () => {
    expect(appendWithinBudget('', 'aé', 2)).toBe('a');
    expect(appendWithinBudget('', 'aé', 3)).toBe('aé');
  });
});

describe('createToolCallRecorder', () => {
  /**
   * A chat turn's rows point at the turn and at nothing else; a run's rows point at the run.
   */
  it('records rows against the run they belong to', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', turnId: 'turn-1' });

    await recorder.start(call('call-1', 1));
    recorder.append({
      type: 'tool.output.delta',
      callId: 'call-1',
      stream: 'stdout',
      text: 'NOTES',
    });
    await recorder.finish(result('call-1'));

    const rows = await container.repos.toolCalls.listByTurn('turn-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: 'ws-1',
      turnId: 'turn-1',
      jobRunId: null,
      toolName: 'run_shell',
      status: 'SUCCEEDED',
      resultHead: 'NOTES',
      resultBytes: 4,
      durationMs: 1500,
    });
  });

  /**
   * The same recorder serves a scheduled run, whose rows carry the run id instead.
   */
  it('records a scheduled run against its run id', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', jobRunId: 'run-1' });

    await recorder.start(call('call-1', 1));
    await recorder.finish(result('call-1'));

    const rows = await container.repos.toolCalls.listByJobRun('run-1');
    expect(rows[0]).toMatchObject({ jobRunId: 'run-1', turnId: null });
  });

  /**
   * A call that produced nothing records no head, so the transcript shows an empty result rather
   * than an empty string that looks like output.
   */
  it('records no head for a call that produced no output', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', turnId: 'turn-1' });

    await recorder.start(call('call-1', 1));
    await recorder.finish(result('call-1'));

    expect((await container.repos.toolCalls.listByTurn('turn-1'))[0]?.resultHead).toBeNull();
  });

  /**
   * The head is capped: a tool that prints a large file must not be held whole in worker memory
   * for the length of the turn.
   */
  it('caps the accumulated head', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', turnId: 'turn-1' });
    await recorder.start(call('call-1', 1));

    for (let chunk = 0; chunk < 4; chunk += 1) {
      recorder.append({
        type: 'tool.output.delta',
        callId: 'call-1',
        stream: 'stdout',
        text: 'x'.repeat(TOOL_OUTPUT_HEAD_BYTES),
      });
    }
    await recorder.finish(result('call-1'));

    const head = (await container.repos.toolCalls.listByTurn('turn-1'))[0]?.resultHead ?? '';
    expect(head).toHaveLength(TOOL_OUTPUT_HEAD_BYTES);
  });

  /**
   * Summaries follow the agent's own numbering, not the order results happened to arrive in, and a
   * call still running has no summary to give.
   */
  it('summarises finished calls in the agent order', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', turnId: 'turn-1' });

    await recorder.start(call('call-2', 2));
    await recorder.start(call('call-1', 1));
    await recorder.start(call('call-3', 3));
    await recorder.finish(result('call-2'));
    await recorder.finish(result('call-1'));

    expect(recorder.summaries()).toEqual(['ran `ls` → exit 0 (2 s)', 'ran `ls` → exit 0 (2 s)']);
    expect((await container.repos.toolCalls.listByTurn('turn-1')).at(-1)?.status).toBe('RUNNING');
  });

  /**
   * An output chunk or a result for a call nobody started is a protocol slip, not a crash: it is
   * reported and dropped so the rest of the turn still lands.
   */
  it('reports an event for a call it never saw start', async () => {
    const container = createTestContainer();
    const recorder = createToolCallRecorder(container, { workspaceId: 'ws-1', turnId: 'turn-1' });

    recorder.append({ type: 'tool.output.delta', callId: 'ghost', stream: 'stdout', text: 'x' });
    await recorder.finish(result('ghost'));

    expect(container.logs.join('')).toContain('tool event for an unknown call');
    expect(await container.repos.toolCalls.listByTurn('turn-1')).toHaveLength(0);
  });
});
