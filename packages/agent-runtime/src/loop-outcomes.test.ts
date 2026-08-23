/**
 * Unit tests for the turn loop: every way a turn ends other than by answering.
 *
 * Layer: unit.
 * Goal: both limits stop the turn as a completion rather than a failure, cancellation ends it at
 * the first opportunity and emits nothing afterwards, a rate limit is retried with backoff while
 * every other provider error is not, and a push is reported only when it actually landed. The
 * ordinary shape of a turn is `loop.test.ts`.
 * Mocks: the shared `FakeAgentModelProvider` for the model, through `createLoopHarness`; a real
 * bare repository for the push case.
 */
import type { AgentModelProvider, ModelEvent, ModelTurnInput } from '@agent-hangar/core';
import { FAKE_USAGE, simpleAnswer } from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { createGitRunner } from './git.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import { createLoopHarness, errorScript, scripted } from './testing/loop-harness.js';

/** Terminal events, after which the loop must emit nothing at all. */
const TERMINAL_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

const harness = createLoopHarness('loop-outcomes');

describe('runTurnLoop and limits', () => {
  /** A limit is not a failure: the work so far is real and the user should see it. */
  it('stops at the step limit and reports it as a completion', async () => {
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
    const outcome = await harness.run(
      harness.request('loop forever', { maxSteps: 1 }),
      scripted(script),
    );
    // The worker reads this to decide whether the turn ended or broke, and a limit is an ending.
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(harness.events.at(-1)).toMatchObject({
      type: 'turn.completed',
      steps: 1,
      stoppedBy: 'limit',
    });
    expect(harness.events.at(-2)).toMatchObject({ type: 'assistant.message' });
    expect(JSON.stringify(harness.events.at(-1))).toContain('no final message');
  });

  /** Cutting a turn short must not throw away what the agent already reported. */
  it('keeps the last answer in the limit message when there was one', async () => {
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
    await harness.run(harness.request('keep going', { maxSteps: 1 }), scripted(script));
    expect(JSON.stringify(harness.events.at(-1))).toContain('I started on the refactor.');
  });

  /** A turn that is merely slow must still end within the operator's budget. */
  it('stops at the wall-clock limit between steps', async () => {
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
    await harness.run(harness.request('be slow', { maxTurnMs: 60_000 }), scripted(script), {
      now: () => {
        clock += 40_000;
        return clock;
      },
    });
    expect(harness.events.at(-1)).toMatchObject({ stoppedBy: 'limit' });
    expect(JSON.stringify(harness.events.at(-1))).toContain('1 min (limit reached)');
  });

  /**
   * The limit is a budget that has been spent, not one that has been exceeded: a turn standing
   * exactly on it has no time left to start another step with. Measured on the limit rather than
   * past it, because the test above lands well beyond it and passes either way.
   */
  it('stops when the clock stands exactly on the wall-clock limit', async () => {
    let first = true;
    const now = (): number => {
      if (first) {
        first = false;
        return 0;
      }
      return 60_000;
    };

    const outcome = await harness.run(
      harness.request('be slow', { maxTurnMs: 60_000 }),
      scripted({ default: simpleAnswer('never asked') }),
      { now },
    );

    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(harness.events.at(-1)).toMatchObject({ stoppedBy: 'limit', steps: 0 });
  });
});

describe('runTurnLoop and cancellation', () => {
  /** The worker can cancel between preparing the turn and the first step. */
  it('emits nothing but the cancellation when the turn was already cancelled', async () => {
    harness.cancel();
    const outcome = await harness.run(
      harness.request('hi'),
      scripted({ default: simpleAnswer('never') }),
    );
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(harness.eventTypes()).toStrictEqual(['turn.cancelled']);
  });

  /** Aborting ends the provider stream silently, which the loop reads as a cancellation. */
  it('ends the turn when the model stream is cancelled part way through', async () => {
    const provider: AgentModelProvider = {
      name: 'aborting',
      async *stream(input: ModelTurnInput) {
        yield { type: 'text.delta', text: 'thinking' };
        harness.cancel();
        await Promise.resolve();
        expect(input.signal?.aborted).toBe(true);
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await harness.run(harness.request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(harness.eventTypes()).toStrictEqual([
      'step.started',
      'assistant.delta',
      'turn.cancelled',
    ]);
  });

  /** Cancellation must not be discovered only after every queued call has run. */
  it('stops before the next tool call once the turn is cancelled', async () => {
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
      harness.cancel();
    }, 150);
    const outcome = await harness.run(harness.request('sleep twice'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(harness.events.filter((event) => event.type === 'tool.call')).toHaveLength(1);
    expect(harness.events.at(-1)?.type).toBe('turn.cancelled');
  });

  /** Every path out of the loop has to leave the stream closed. */
  it('never emits anything after a terminal event', async () => {
    await harness.run(harness.request('hi'), scripted({ default: simpleAnswer('Bye.') }));
    const terminal = harness.eventTypes().findIndex((type) => TERMINAL_TYPES.has(type));
    expect(terminal).toBe(harness.events.length - 1);
  });
});

describe('runTurnLoop and provider failures', () => {
  /** The provider's own guidance: back off, do not give up on the first 429. */
  it('retries a rate limit with exponential backoff and then succeeds', async () => {
    const slept: number[] = [];
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('Finally.'),
      ],
    };
    const outcome = await harness.run(harness.request('hi'), scripted(script), {
      sleep: async (ms) => {
        slept.push(ms);
        await Promise.resolve();
      },
    });
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(slept).toStrictEqual([1000, 2000]);
  });

  /** The default backoff has to actually wait, or a retry storm is no better than no retry. */
  it('waits for real time when no sleep is injected', async () => {
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('Recovered.'),
      ],
    };
    const started = Date.now();
    const outcome = await harness.run(harness.request('hi'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'completed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  /** Waiting out a full backoff after the operator hit cancel is the worst of both worlds. */
  it('ends the turn when a cancellation arrives during the real backoff', async () => {
    const script: ProviderScript = {
      default: [
        { events: [{ type: 'error', code: 'rate_limit', message: 'slow down', retryable: true }] },
        ...simpleAnswer('never reached'),
      ],
    };
    setTimeout(() => {
      harness.cancel();
    }, 50);
    const started = Date.now();
    const outcome = await harness.run(harness.request('hi'), scripted(script));
    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(900);
  });

  /** Four attempts is the documented budget; the turn then fails with the provider's code. */
  it('gives up after the last retry', async () => {
    const outcome = await harness.run(harness.request('hi'), scripted(errorScript('rate_limit')), {
      sleep: () => Promise.resolve(),
    });
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'rate_limit' });
    expect(harness.events.at(-1)).toMatchObject({
      type: 'turn.failed',
      error: { code: 'rate_limit' },
    });
  });

  /** Cancelling must not have to wait out the remaining retries. */
  it('ends the turn on a cancellation that arrives during a backoff', async () => {
    const provider = scripted(errorScript('rate_limit'));

    const outcome = await harness.run(harness.request('hi'), provider, {
      sleep: async () => {
        harness.cancel();
        await Promise.resolve();
      },
    });

    expect(outcome).toStrictEqual({ kind: 'cancelled' });
    expect(harness.events.at(-1)?.type).toBe('turn.cancelled');
    // And the retry it was waiting to make never happened. A cancelled turn that still sends the
    // next request pays for it, and waits for it, before noticing it had been told to stop.
    expect(provider.calls).toHaveLength(1);
  });

  /** A bad API key will not fix itself, and the UI links the operator to Settings. */
  it('does not retry an error that is not a rate limit', async () => {
    const outcome = await harness.run(harness.request('hi'), scripted(errorScript('auth')));
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'auth' });
  });

  /** Silence is not success: reporting it as a completion would lose the turn's real state. */
  it('treats a stream that ends without a response as an unknown failure', async () => {
    const provider: AgentModelProvider = {
      name: 'silent',
      async *stream() {
        await Promise.resolve();
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await harness.run(harness.request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'unknown' });
    expect(JSON.stringify(harness.events.at(-1))).toContain('without response.done');
  });

  /** A transport bug must surface as a failed turn, not as an unhandled rejection. */
  it('treats a provider that throws as an unknown failure', async () => {
    const provider: AgentModelProvider = {
      name: 'broken',
      async *stream() {
        await Promise.resolve();
        throw new Error('socket hang up');
      },
      listModels: () => Promise.resolve([]),
    };
    const outcome = await harness.run(harness.request('hi'), provider);
    expect(outcome).toStrictEqual({ kind: 'failed', code: 'unknown' });
    expect(JSON.stringify(harness.events.at(-1))).toContain('socket hang up');
  });
});

describe('runTurnLoop and git pushes', () => {
  /** The host stores this so the chat can show the branch and the commit. */
  it('reports where the work landed after a successful push', async () => {
    const repo = await createBareRepoWithSeed();
    const git = createGitRunner();
    await git.run(['clone', '--branch', 'main', '--', repo.url, '.'], {
      cwd: harness.root,
      env: harness.childEnv,
    });
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
      await harness.run(harness.request('commit and push'), scripted(script), { git });
      const pushed = harness.events.find((event) => event.type === 'git.pushed');
      expect(pushed).toMatchObject({ branch: 'main' });
      expect(harness.eventTypes().indexOf('git.pushed')).toBeGreaterThan(
        harness.eventTypes().indexOf('tool.result'),
      );
    } finally {
      await repo.cleanup();
    }
  });

  /**
   * Detection has two halves and this is the one the failing push above cannot exercise: that
   * workspace holds no repository, so a command wrongly taken for a push finds no head to report
   * and stays silent for the wrong reason. Here the repository is real and the command is
   * ordinary, so anything reported would be reported about work that never happened.
   */
  it('reports nothing for a shell command that is not a push', async () => {
    const repo = await createBareRepoWithSeed();
    const git = createGitRunner();
    await git.run(['clone', '--branch', 'main', '--', repo.url, '.'], {
      cwd: harness.root,
      env: harness.childEnv,
    });
    const script: ProviderScript = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({ command: 'echo hello', cwd: null, timeoutMs: 15_000 }),
            },
            { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE },
          ],
        },
        ...simpleAnswer('Said hello.'),
      ],
    };

    try {
      await harness.run(harness.request('say hello'), scripted(script), { git });

      expect(harness.eventTypes()).not.toContain('git.pushed');
    } finally {
      await repo.cleanup();
    }
  });

  /** A rejected push leaves the remote where it was, and the host must not record otherwise. */
  it('reports nothing when the push failed', async () => {
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
    await harness.run(harness.request('push it'), scripted(script));
    expect(harness.eventTypes()).not.toContain('git.pushed');
  });

  /** Detection reads the output, which a script can produce anywhere. */
  it('reports nothing when the workspace is not a repository', async () => {
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
    await harness.run(harness.request('fake a push'), scripted(script));
    expect(harness.eventTypes()).not.toContain('git.pushed');
  });
});
