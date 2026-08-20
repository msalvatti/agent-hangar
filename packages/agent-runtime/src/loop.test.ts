/**
 * Unit tests for the turn loop.
 *
 * Layer: unit.
 * Goal: the event sequence of the protocol is produced in exactly the documented order, both
 * limits stop the turn as a completion rather than a failure, cancellation ends it at the first
 * opportunity and emits nothing afterwards, a rate limit is retried with backoff and every other
 * provider error is not, and a successful push is reported.
 * Mocks: the shared `FakeAgentModelProvider` for the model; real tools against a temporary
 * directory; a real bare repository for the push case.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentEvent,
  AgentModelProvider,
  ModelEvent,
  ModelTurnInput,
  TurnRequest,
} from '@agent-hangar/core';
import {
  FAKE_USAGE,
  FakeAgentModelProvider,
  simpleAnswer,
  toolThenAnswer,
} from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChildEnv } from './child-env.js';
import { createGitRunner } from './git.js';
import { runTurnLoop } from './loop.js';
import type { LoopDeps, LoopOutcome } from './loop.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';
import { createToolExecutor, TOOL_DEFINITIONS } from './tools/index.js';

/** Terminal events, after which the loop must emit nothing at all. */
const TERMINAL_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

const childEnv = createChildEnv({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
});

let root: string;
let events: AgentEvent[];
let controller: AbortController;

/**
 * Builds a request whose last user message selects a script.
 *
 * @param prompt - Text of the user message.
 * @param limits - Limit overrides.
 * @returns The request.
 */
function request(prompt: string, limits: Partial<TurnRequest['limits']> = {}): TurnRequest {
  return {
    protocolVersion: 1,
    turnId: 'turn-1',
    model: 'fake-model',
    instructions: 'be useful',
    items: [{ role: 'user', content: prompt }],
    repo: { url: 'https://github.com/acme/widgets', baseBranch: 'main', workBranch: 'agent/x' },
    limits: {
      maxSteps: 8,
      maxTurnMs: 1_200_000,
      toolTimeoutMs: 10_000,
      maxToolOutputBytes: 32_768,
      ...limits,
    },
    prepare: { clone: false },
  };
}

/**
 * Runs the loop against a scripted provider.
 *
 * @param turn - The request.
 * @param provider - Provider to stream from.
 * @param overrides - Loop dependencies to replace.
 * @returns How the turn ended.
 */
async function run(
  turn: TurnRequest,
  provider: AgentModelProvider,
  overrides: Partial<LoopDeps> = {},
): Promise<LoopOutcome> {
  return runTurnLoop({
    request: turn,
    provider,
    tools: createToolExecutor({
      workspaceRoot: root,
      childEnv,
      toolTimeoutMs: turn.limits.toolTimeoutMs,
      maxToolOutputBytes: turn.limits.maxToolOutputBytes,
    }),
    toolDefinitions: TOOL_DEFINITIONS,
    emit: async (event) => {
      events.push(event);
      await Promise.resolve();
    },
    redactText: (text) => text,
    lastEmittedAt: () => 0,
    workspaceRoot: root,
    childEnv,
    git: createGitRunner(),
    signal: controller.signal,
    ...overrides,
  });
}

/**
 * Lists the types of the emitted events.
 *
 * @returns One type per event, in order.
 */
function eventTypes(): string[] {
  return events.map((event) => event.type);
}

/**
 * Builds a provider from a script map.
 *
 * @param script - Steps keyed by the last user message.
 * @returns The provider.
 */
function scripted(script: ProviderScript): FakeAgentModelProvider {
  return new FakeAgentModelProvider({ script });
}

/**
 * Builds a one-step script that ends with an error.
 *
 * @param code - Error category.
 * @returns The script.
 */
function errorScript(code: 'rate_limit' | 'auth'): ProviderScript {
  const events_: ModelEvent[] = [
    { type: 'error', code, message: `${code} from provider`, retryable: code === 'rate_limit' },
  ];
  return {
    default: [{ events: events_ }, { events: events_ }, { events: events_ }, { events: events_ }],
  };
}

beforeEach(async () => {
  root = await makeTempDir('loop');
  events = [];
  controller = new AbortController();
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('runTurnLoop without tool calls', () => {
  it('streams the answer and completes with the summed usage', async () => {
    // The simplest turn: one round-trip, one answer, done.
    const outcome = await run(request('hi'), scripted({ default: simpleAnswer('Hello there.') }));
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(eventTypes()).toStrictEqual([
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    expect(events.at(-1)).toStrictEqual({
      type: 'turn.completed',
      usage: FAKE_USAGE,
      steps: 1,
      finalMessage: 'Hello there.',
    });
  });

  it('completes with an empty final message when the model answered nothing', async () => {
    // A model that returns neither text nor a tool call still ends the turn cleanly.
    const script: ProviderScript = {
      default: [{ events: [{ type: 'response.done', responseId: 'r1', usage: FAKE_USAGE }] }],
    };
    await run(request('hi'), scripted(script));
    expect(eventTypes()).toStrictEqual(['step.started', 'turn.completed']);
    expect(events.at(-1)).toMatchObject({ finalMessage: '' });
  });
});

describe('runTurnLoop with tool calls', () => {
  it('runs a tool, feeds the result back and answers on the next step', async () => {
    // The shape of every real turn: call, result, answer.
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
    const outcome = await run(request('write notes'), provider);
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(eventTypes()).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    await expect(readFile(path.join(root, 'NOTES.md'), 'utf8')).resolves.toBe('# Notes\n');
    const second = provider.calls[1];
    expect(second?.items.map((item) => ('type' in item ? item.type : item.role))).toStrictEqual([
      'user',
      'tool_call',
      'tool_result',
    ]);
  });

  it('runs two calls of one step in order, each after the previous result', async () => {
    // Sequential execution is what makes the transcript readable and the workspace predictable.
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
    await run(request('write both'), scripted(script));
    expect(eventTypes()).toStrictEqual([
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
    const calls = events.filter((event) => event.type === 'tool.call');
    expect(calls.map((event) => event.seq)).toStrictEqual([1, 2]);
  });

  it('streams shell output before the result of the same call', async () => {
    // The transcript shows a long command's output while it is still running.
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
    await run(request('run it'), scripted(script));
    expect(eventTypes().slice(0, 4)).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
    ]);
  });

  it('reports the output of a tool that never streams, once, before its result', async () => {
    // Only `run_shell` streams. Without an event of its own, a `list_dir` would reach the model
    // and nothing else: `tool.result` carries the byte count and the status but not the text, so
    // the persisted row and the transcript would show a size beside no output at all.
    await writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
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
    await run(request('list it'), provider);
    expect(eventTypes().slice(0, 4)).toStrictEqual([
      'step.started',
      'tool.call',
      'tool.output.delta',
      'tool.result',
    ]);
    const deltas = events.filter((event) => event.type === 'tool.output.delta');
    expect(deltas).toStrictEqual([
      { type: 'tool.output.delta', callId: 'c1', stream: 'stdout', text: 'a.txt' },
    ]);
  });

  it('reports the message of a failed call that never streams, on stderr', async () => {
    // The reason a call did not work is the one thing its row has to show; it arrives on the same
    // road as any other output, and stderr is what the transcript renders as a failure.
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
    await run(request('read it'), provider);
    const deltas = events.filter((event) => event.type === 'tool.output.delta');
    expect(deltas).toStrictEqual([
      {
        type: 'tool.output.delta',
        callId: 'c1',
        stream: 'stderr',
        text: 'file not found: missing.md',
      },
    ]);
  });

  it('emits no output event for a call that produced no output', async () => {
    // A command that says nothing must not be given an empty line to say it with: the transcript
    // reads "No output" from the absence of the event, not from an event carrying nothing.
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
    await run(request('run quiet'), provider);
    expect(eventTypes().slice(0, 3)).toStrictEqual(['step.started', 'tool.call', 'tool.result']);
  });

  it('survives a stream event that could not be written', async () => {
    // Output deltas are written without waiting; a broken pipe there must not crash the turn,
    // because the awaited emits around it already report the same failure.
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
    const outcome = await run(request('run it'), scripted(script), {
      emit: async (event) => {
        events.push(event);
        if (event.type === 'tool.output.delta') {
          throw new Error('pipe closed');
        }
        await Promise.resolve();
      },
    });
    expect(outcome).toStrictEqual({ kind: 'completed' });
  });

  it.each([
    ['arguments the schema rejects', JSON.stringify({ nope: 1 })],
    ['arguments that are not JSON at all', 'not json'],
  ])('reports %s as a failed result the model can read', async (_name, args) => {
    // The model corrects itself on the next step instead of the turn ending.
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
    await run(request('read it'), provider);
    expect(events.find((event) => event.type === 'tool.result')).toMatchObject({
      status: 'FAILED',
    });
    const fedBack = provider.calls[1]?.items.at(-1);
    expect(fedBack).toMatchObject({ type: 'tool_result' });
    expect(JSON.stringify(fedBack)).toContain('invalid arguments');
  });

  it('reports an unknown tool to the model without emitting an unusable event', async () => {
    // `tool.call` can only carry a known tool, and a line the worker rejects is worse than none.
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
    await run(request('remove it'), provider);
    expect(eventTypes()).toStrictEqual([
      'step.started',
      'step.started',
      'assistant.delta',
      'assistant.message',
      'turn.completed',
    ]);
    expect(JSON.stringify(provider.calls[1]?.items)).toContain('unknown tool');
  });
});

describe('runTurnLoop and limits', () => {
  it('stops at the step limit and reports it as a completion', async () => {
    // A limit is not a failure: the work so far is real and the user should see it.
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.txt', content: 'x' }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
      ],
    };
    await run(request('loop forever', { maxSteps: 1 }), scripted(script));
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', steps: 1, stoppedBy: 'limit' });
    expect(events.at(-2)).toMatchObject({ type: 'assistant.message' });
    expect(JSON.stringify(events.at(-1))).toContain('no final message');
  });

  it('keeps the last answer in the limit message when there was one', async () => {
    // Cutting a turn short must not throw away what the agent already reported.
    const toolCall: ModelEvent = {
      type: 'tool_call',
      callId: 'c1',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'a.txt', content: 'x' }),
    };
    const script: ProviderScript = {
      default: [
        {
          events: [
            { type: 'text.done', text: 'I started on the refactor.' },
            toolCall,
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
      ],
    };
    await run(request('keep going', { maxSteps: 1 }), scripted(script));
    expect(JSON.stringify(events.at(-1))).toContain('I started on the refactor.');
  });

  it('stops at the wall-clock limit between steps', async () => {
    // A turn that is merely slow must still end within the operator's budget.
    let clock = 0;
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.txt', content: 'x' }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Slow but done.'),
      ],
    };
    await run(request('be slow', { maxTurnMs: 60_000 }), scripted(script), {
      now: () => {
        clock += 40_000;
        return clock;
      },
    });
    expect(events.at(-1)).toMatchObject({ stoppedBy: 'limit' });
    expect(JSON.stringify(events.at(-1))).toContain('1 min (limit reached)');
  });
});

describe('runTurnLoop and cancellation', () => {
  it('emits nothing but the cancellation when the turn was already cancelled', async () => {
    // The worker can cancel between preparing the turn and the first step.
    controller.abort();
    const outcome = await run(request('hi'), scripted({ default: simpleAnswer('never') }));
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(eventTypes()).toStrictEqual(['turn.cancelled']);
  });

  it('ends the turn when the model stream is cancelled part way through', async () => {
    // Aborting ends the provider stream silently, which the loop reads as a cancellation.
    const provider: AgentModelProvider = {
      name: 'aborting',
      async *stream(input: ModelTurnInput) {
        yield { type: 'text.delta', text: 'thinking' };
        controller.abort();
        await Promise.resolve();
        expect(input.signal?.aborted).toBe(true);
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await run(request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(eventTypes()).toStrictEqual(['step.started', 'assistant.delta', 'turn.cancelled']);
  });

  it('stops before the next tool call once the turn is cancelled', async () => {
    // Cancellation must not be discovered only after every queued call has run.
    const call = (callId: string): ModelEvent => ({
      type: 'tool_call',
      callId,
      name: 'run_shell',
      arguments: JSON.stringify({ command: 'sleep 30', cwd: null, timeoutMs: 10_000 }),
    });
    const script: ProviderScript = {
      default: [
        {
          events: [
            call('c1'),
            call('c2'),
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
      ],
    };
    setTimeout(() => {
      controller.abort();
    }, 150);
    const outcome = await run(request('sleep twice'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(events.filter((event) => event.type === 'tool.call')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('turn.cancelled');
  });

  it('never emits anything after a terminal event', async () => {
    // Every path out of the loop has to leave the stream closed.
    await run(request('hi'), scripted({ default: simpleAnswer('Bye.') }));
    const terminal = eventTypes().findIndex((type) => TERMINAL_TYPES.has(type));
    expect(terminal).toBe(events.length - 1);
  });
});

describe('runTurnLoop and provider failures', () => {
  it('retries a rate limit with exponential backoff and then succeeds', async () => {
    // The provider's own guidance: back off, do not give up on the first 429.
    const slept: number[] = [];
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('Finally.'),
      ],
    };
    const outcome = await run(request('hi'), scripted(script), {
      sleep: async (ms) => {
        slept.push(ms);
        await Promise.resolve();
      },
    });
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(slept).toStrictEqual([1000, 2000]);
  });

  it('waits for real time when no sleep is injected', async () => {
    // The default backoff has to actually wait, or a retry storm is no better than no retry.
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('Recovered.'),
      ],
    };
    const started = Date.now();
    const outcome = await run(request('hi'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('ends the turn when a cancellation arrives during the real backoff', async () => {
    // Waiting out a full backoff after the operator hit cancel is the worst of both worlds.
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('never reached'),
      ],
    };
    setTimeout(() => {
      controller.abort();
    }, 50);
    const started = Date.now();
    const outcome = await run(request('hi'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('gives up after the last retry', async () => {
    // Four attempts is the documented budget; the turn then fails with the provider's code.
    const outcome = await run(request('hi'), scripted(errorScript('rate_limit')), {
      sleep: () => Promise.resolve(),
    });
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'rate_limit' });
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'rate_limit' } });
  });

  it('ends the turn on a cancellation that arrives during a backoff', async () => {
    // Cancelling must not have to wait out the remaining retries.
    const outcome = await run(request('hi'), scripted(errorScript('rate_limit')), {
      sleep: async () => {
        controller.abort();
        await Promise.resolve();
      },
    });
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(events.at(-1)?.type).toBe('turn.cancelled');
  });

  it('does not retry an error that is not a rate limit', async () => {
    // A bad API key will not fix itself, and the UI links the operator to Settings.
    const outcome = await run(request('hi'), scripted(errorScript('auth')));
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'auth' });
  });

  it('treats a stream that ends without a response as an unknown failure', async () => {
    // Silence is not success: reporting it as a completion would lose the turn's real state.
    const provider: AgentModelProvider = {
      name: 'silent',
      async *stream() {
        await Promise.resolve();
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await run(request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'unknown' });
    expect(JSON.stringify(events.at(-1))).toContain('without response.done');
  });

  it('treats a provider that throws as an unknown failure', async () => {
    // A transport bug must surface as a failed turn, not as an unhandled rejection.
    const provider: AgentModelProvider = {
      name: 'broken',
      async *stream() {
        await Promise.resolve();
        throw new Error('socket hang up');
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await run(request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'unknown' });
    expect(JSON.stringify(events.at(-1))).toContain('socket hang up');
  });
});

describe('runTurnLoop and the heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces the turn is alive while nothing has been written, and stops afterwards', async () => {
    // A long tool call would otherwise look like a dead stream to the browser.
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
    const pending = run(request('hi'), provider, {
      heartbeatMs: 10_000,
      now: () => clock,
      lastEmittedAt: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eventTypes()).toContain('heartbeat');
    const beforeRelease = events.length;
    released();
    await pending;
    clock = 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.length).toBeGreaterThan(beforeRelease);
    expect(events.filter((event) => event.type === 'heartbeat')).toHaveLength(1);
  });

  it('stays quiet while events are still flowing', async () => {
    // A heartbeat on top of a busy stream is noise the transcript does not need.
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
    const pending = run(request('hi'), provider, {
      heartbeatMs: 10_000,
      now: () => clock,
      lastEmittedAt: () => clock - 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(eventTypes()).not.toContain('heartbeat');
    released();
    await pending;
  });
});

describe('runTurnLoop and git pushes', () => {
  it('reports where the work landed after a successful push', async () => {
    // The host stores this so the chat can show the branch and the commit.
    const repo = await createBareRepoWithSeed();
    const git = createGitRunner();
    await git.run(['clone', '--branch', 'main', '--', repo.url, '.'], { cwd: root, env: childEnv });
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({
                command:
                  'git -c user.name=t -c user.email=t@example.com commit --allow-empty -m work && git push origin HEAD',
                cwd: null,
                timeoutMs: 15_000,
              }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Pushed.'),
      ],
    };
    try {
      await run(request('commit and push'), scripted(script), { git });
      const pushed = events.find((event) => event.type === 'git.pushed');
      expect(pushed).toMatchObject({ branch: 'main' });
      expect(eventTypes().indexOf('git.pushed')).toBeGreaterThan(
        eventTypes().indexOf('tool.result'),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports nothing when the push failed', async () => {
    // A rejected push leaves the remote where it was, and the host must not record otherwise.
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({
                command: 'git push origin HEAD',
                cwd: null,
                timeoutMs: 15_000,
              }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Could not push.'),
      ],
    };
    await run(request('push it'), scripted(script));
    expect(eventTypes()).not.toContain('git.pushed');
  });

  it('reports nothing when the workspace is not a repository', async () => {
    // Detection reads the output, which a script can produce anywhere.
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({
                command: "printf 'To https://x/y.git\\n   a..b  main -> main\\n'",
                cwd: null,
                timeoutMs: 15_000,
              }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Odd output.'),
      ],
    };
    await run(request('fake a push'), scripted(script));
    expect(eventTypes()).not.toContain('git.pushed');
  });
});

describe('runTurnLoop and what the model is shown', () => {
  it('redacts a tool result before it becomes provider input', async () => {
    // The event writer guards stdout, but the conversation is a second road out of this process
    // and the only one the model reads. `run_shell` can print the git token file, so an
    // unredacted tool result would send the PAT to the provider on the very next step.
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

    await run(request('print it'), provider, {
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
