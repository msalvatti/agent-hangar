/**
 * Unit tests for the turn loop: the ordinary shape of a turn, from the first step to the answer.
 *
 * Layer: unit.
 * Goal: the event sequence of the protocol is produced in exactly the documented order, a tool
 * call's output reaches the transcript before its result and the model on the step after it, the
 * heartbeat speaks only while the stream is otherwise silent, and nothing the model is shown
 * carries a credential. How a turn ends other than by answering — limits, cancellation, a provider
 * that fails, and what landed on the remote — is `loop-outcomes.test.ts`; what preparation tells
 * the model is `loop-prepare-notes.test.ts`.
 * Mocks: the shared `FakeAgentModelProvider` for the model, through `createLoopHarness`; real tools
 * against a temporary directory.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentModelProvider, ModelEvent } from '@agent-hangar/core';
import { FAKE_USAGE, simpleAnswer, toolThenAnswer } from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoopHarness, scripted } from './testing/loop-harness.js';

const harness = createLoopHarness('loop');

describe('runTurnLoop without tool calls', () => {
  /** The simplest turn: one round-trip, one answer, done. */
  it('streams the answer and completes with the summed usage', async () => {
    const outcome = await harness.run(
      harness.request('hi'),
      scripted({ default: simpleAnswer('Hello there.') }),
    );
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(harness.eventTypes()).toStrictEqual([
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    expect(harness.events.at(-1)).toStrictEqual({
      type: 'turn.completed',
      usage: FAKE_USAGE,
      steps: 1,
      finalMessage: 'Hello there.',
    });
  });

  /** A model that returns neither text nor a tool call still ends the turn cleanly. */
  it('completes with an empty final message when the model answered nothing', async () => {
    const script: ProviderScript = {
      default: [{ events: [{ type: 'response.done', responseId: 'r1', usage: FAKE_USAGE }] }],
    };
    await harness.run(harness.request('hi'), scripted(script));
    expect(harness.eventTypes()).toStrictEqual(['step.started', 'turn.completed']);
    expect(harness.events.at(-1)).toMatchObject({ finalMessage: '' });
  });
});

describe('runTurnLoop with tool calls', () => {
  /** The shape of every real turn: call, result, answer. */
  it('runs a tool, feeds the result back and answers on the next step', async () => {
    const provider = scripted({
      default: toolThenAnswer(
        {
          callId: 'c1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'NOTES.md', content: '# Notes\n' }),
        },
        'Created NOTES.md.',
      ),
    });
    const outcome = await harness.run(harness.request('write notes'), provider);
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(harness.eventTypes()).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    await expect(readFile(path.join(harness.root, 'NOTES.md'), 'utf8')).resolves.toBe('# Notes\n');
    const second = provider.calls[1];
    expect(second?.items.map((item) => ('type' in item ? item.type : item.role))).toStrictEqual([
      'user',
      'tool_call',
      'tool_result',
    ]);
  });

  /** Sequential execution is what makes the transcript readable and the workspace predictable. */
  it('runs two calls of one step in order, each after the previous result', async () => {
    const call = (callId: string, path_: string): ModelEvent => ({
      type: 'tool_call',
      callId,
      name: 'write_file',
      arguments: JSON.stringify({ path: path_, content: 'x' }),
    });
    const script: ProviderScript = {
      default: [
        {
          events: [
            call('c1', 'a.txt'),
            call('c2', 'b.txt'),
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Both written.'),
      ],
    };
    await harness.run(harness.request('write both'), scripted(script));
    expect(harness.eventTypes()).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
      'tool.call',
      'tool.output.delta',
      'tool.result',
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    const calls = harness.events.filter((event) => event.type === 'tool.call');
    expect(calls.map((event) => event.seq)).toStrictEqual([1, 2]);
  });

  /** The transcript shows a long command's output while it is still running. */
  it('streams shell output before the result of the same call', async () => {
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({ command: 'echo streaming', cwd: null, timeoutMs: null }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Done.'),
      ],
    };
    await harness.run(harness.request('run it'), scripted(script));
    expect(harness.eventTypes().slice(0, 4)).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
    ]);
  });

  /**
   * Only `run_shell` streams. Without an event of its own, a `list_dir` would reach the model and
   * nothing else: `tool.result` carries the byte count and the status but not the text, so the
   * persisted row and the transcript would show a size beside no output at all.
   */
  it('reports the output of a tool that never streams, once, before its result', async () => {
    await writeFile(path.join(harness.root, 'a.txt'), 'x', 'utf8');
    const provider = scripted({
      default: toolThenAnswer(
        {
          callId: 'c1',
          name: 'list_dir',
          arguments: JSON.stringify({ path: '.', depth: 1 }),
        },
        'Listed.',
      ),
    });
    await harness.run(harness.request('list it'), provider);
    expect(harness.eventTypes().slice(0, 4)).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
    ]);
    const deltas = harness.events.filter((event) => event.type === 'tool.output.delta');
    expect(deltas).toStrictEqual([
      { type: 'tool.output.delta', callId: 'c1', stream: 'stdout', text: 'a.txt' },
    ]);
  });

  /**
   * The reason a call did not work is the one thing its row has to show; it arrives on the same
   * road as any other output, and stderr is what the transcript renders as a failure.
   */
  it('reports the message of a failed call that never streams, on stderr', async () => {
    const provider = scripted({
      default: toolThenAnswer(
        {
          callId: 'c1',
          name: 'read_file',
          arguments: JSON.stringify({ path: 'missing.md', startLine: null, endLine: null }),
        },
        'It is not there.',
      ),
    });
    await harness.run(harness.request('read it'), provider);
    const deltas = harness.events.filter((event) => event.type === 'tool.output.delta');
    expect(deltas).toStrictEqual([
      {
        type: 'tool.output.delta',
        callId: 'c1',
        stream: 'stderr',
        text: 'file not found: missing.md',
      },
    ]);
  });

  /**
   * A command that says nothing must not be given an empty line to say it with: the transcript
   * reads "No output" from the absence of the event, not from an event carrying nothing.
   */
  it('emits no output event for a call that produced no output', async () => {
    const provider = scripted({
      default: toolThenAnswer(
        {
          callId: 'c1',
          name: 'run_shell',
          arguments: JSON.stringify({ command: 'true', cwd: null, timeoutMs: null }),
        },
        'Nothing to say.',
      ),
    });
    await harness.run(harness.request('run quiet'), provider);
    expect(harness.eventTypes().slice(0, 3)).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.result',
    ]);
  });

  /**
   * Output deltas are written without waiting; a broken pipe there must not crash the turn, because
   * the awaited emits around it already report the same failure.
   */
  it('survives a stream event that could not be written', async () => {
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({ command: 'echo hi', cwd: null, timeoutMs: null }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Done.'),
      ],
    };
    const outcome = await harness.run(harness.request('run it'), scripted(script), {
      emit: async (event) => {
        harness.events.push(event);
        if (event.type === 'tool.output.delta') {
          throw new Error('pipe closed');
        }
        await Promise.resolve();
      },
    });
    expect(outcome).toStrictEqual({ kind: 'completed' });
  });

  /** The model corrects itself on the next step instead of the turn ending. */
  it.each([
    ['arguments the schema rejects', JSON.stringify({ nope: 1 })],
    ['arguments that are not JSON at all', 'not json'],
  ])('reports %s as a failed result the model can read', async (_name, args) => {
    const script: ProviderScript = {
      default: [
        {
          events: [
            { type: 'tool_call', callId: 'c1', name: 'read_file', arguments: args },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Understood.'),
      ],
    };
    const provider = scripted(script);
    await harness.run(harness.request('read it'), provider);
    expect(harness.events.find((event) => event.type === 'tool.result')).toMatchObject({
      status: 'FAILED',
    });
    const fedBack = provider.calls[1]?.items.at(-1);
    expect(fedBack).toMatchObject({ type: 'tool_result' });
    expect(JSON.stringify(fedBack)).toContain('invalid arguments');
  });

  /** `tool.call` can only carry a known tool, and a line the worker rejects is worse than none. */
  it('reports an unknown tool to the model without emitting an unusable event', async () => {
    const script: ProviderScript = {
      default: [
        {
          events: [
            { type: 'tool_call', callId: 'c1', name: 'rm_rf', arguments: '{}' },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Understood.'),
      ],
    };
    const provider = scripted(script);
    await harness.run(harness.request('remove it'), provider);
    expect(harness.eventTypes()).toStrictEqual([
      'step.started',
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    expect(JSON.stringify(provider.calls[1]?.items)).toContain('unknown tool');
  });
});

describe('runTurnLoop and the heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A long tool call would otherwise look like a dead stream to the browser. */
  it('announces the turn is alive while nothing has been written, and stops afterwards', async () => {
    vi.useFakeTimers();
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const provider: AgentModelProvider = {
      name: 'slow',
      async *stream() {
        await gate;
        yield { type: 'text.done', text: 'eventually' };
        yield { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE };
      },
      listModels: () => Promise.resolve([]),
    };
    let clock = 0;
    // `lastEmittedAt` is left to the harness, whose answer is the same zero: nothing has been
    // written yet, so every tick is overdue until the stream produces something.
    const pending = harness.run(harness.request('hi'), provider, {
      heartbeatMs: 10_000,
      now: () => clock,
    });
    await vi.advanceTimersByTimeAsync(0);
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.eventTypes()).toContain('heartbeat');
    const beforeRelease = harness.events.length;
    released();
    await pending;
    clock = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.events.length).toBeGreaterThan(beforeRelease);
    expect(harness.events.filter((event) => event.type === 'heartbeat')).toHaveLength(1);
  });

  /** A heartbeat on top of a busy stream is noise the transcript does not need. */
  it('stays quiet while events are still flowing', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let released = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const provider: AgentModelProvider = {
      name: 'slow',
      async *stream() {
        await gate;
        yield { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE };
      },
      listModels: () => Promise.resolve([]),
    };
    const pending = harness.run(harness.request('hi'), provider, {
      heartbeatMs: 10_000,
      now: () => clock,
      lastEmittedAt: () => clock - 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.eventTypes()).not.toContain('heartbeat');
    released();
    await pending;
  });
});

describe('runTurnLoop and what the model is shown', () => {
  /**
   * The event writer guards stdout, but the conversation is a second road out of this process and
   * the only one the model reads. `run_shell` can print the git token file, so an unredacted tool
   * result would send the PAT to the provider on the very next step.
   */
  it('redacts a tool result before it becomes provider input', async () => {
    const secret = 'ghp-canary-value-that-must-not-travel';
    const provider = scripted({
      default: toolThenAnswer(
        {
          callId: 'c1',
          name: 'run_shell',
          arguments: JSON.stringify({ command: `echo ${secret}`, cwd: null, timeoutMs: null }),
        },
        'Done.',
      ),
    });

    await harness.run(harness.request('print it'), provider, {
      redactText: (text) => text.split(secret).join('[REDACTED]'),
    });

    // Only the result is examined: the call's own arguments are text the model wrote itself.
    const results = (provider.calls[1]?.items ?? []).filter(
      (item) => 'type' in item && item.type === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).toContain('[REDACTED]');
    expect(JSON.stringify(results)).not.toContain(secret);
  });
});
