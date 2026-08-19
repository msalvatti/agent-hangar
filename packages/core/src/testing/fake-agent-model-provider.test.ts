/**
 * Unit tests for FakeAgentModelProvider.
 *
 * Layer: unit.
 * Goal: script selection by last user message with `default` fallback, one step popped per call
 * (multi-step tool loops), per-step delay, silent abort, exhaustion/missing-script errors, the
 * script builders, `listModels` and `reset`.
 * Mocks: fake timers for delays.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelEvent, ModelTurnInput } from '../model/types.js';

import { assertNoCanary, GITHUB_CANARY } from './canaries.js';
import {
  FAKE_USAGE,
  FakeAgentModelProvider,
  simpleAnswer,
  toolThenAnswer,
} from './fake-agent-model-provider.js';

function input(overrides: Partial<ModelTurnInput> = {}): ModelTurnInput {
  return {
    model: 'fake-model',
    instructions: 'sys',
    items: [{ role: 'user', content: 'hello' }],
    tools: [],
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe('script builders', () => {
  /**
   * `simpleAnswer` yields delta, done and a `response.done` with the fake usage, in one step.
   */
  it('simpleAnswer builds a single text step', () => {
    const [step, ...rest] = simpleAnswer('hi');
    expect(rest).toEqual([]);
    expect(step?.events).toEqual([
      { type: 'text.delta', text: 'hi' },
      { type: 'text.done', text: 'hi' },
      { type: 'response.done', responseId: 'fake-2', usage: FAKE_USAGE },
    ]);
  });

  /**
   * `toolThenAnswer` builds two steps: the tool call (arguments delta + complete call +
   * response.done) and then the text answer.
   */
  it('toolThenAnswer builds a tool step followed by an answer step', () => {
    const steps = toolThenAnswer(
      { callId: 'c1', name: 'run_shell', arguments: '{"command":"ls"}' },
      'done',
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]?.events.map((event) => event.type)).toEqual([
      'tool_call.arguments.delta',
      'tool_call',
      'response.done',
    ]);
    expect(steps[0]?.events[1]).toEqual({
      type: 'tool_call',
      callId: 'c1',
      name: 'run_shell',
      arguments: '{"command":"ls"}',
    });
    expect(steps[1]?.events[1]).toEqual({ type: 'text.done', text: 'done' });
  });
});

describe('FakeAgentModelProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Selection: the exact text of the last user item picks the script; other prompts fall back
   * to `default`; the call is recorded; `name` is "fake".
   */
  it('selects the script by last user message with default fallback', async () => {
    const provider = new FakeAgentModelProvider({
      script: { hello: simpleAnswer('specific'), default: simpleAnswer('generic') },
    });
    expect(provider.name).toBe('fake');
    const specific = await collect(provider.stream(input()));
    expect(specific[1]).toEqual({ type: 'text.done', text: 'specific' });

    const generic = await collect(
      provider.stream(
        input({
          items: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'specific' },
            { role: 'user', content: 'something else' },
          ],
        }),
      ),
    );
    expect(generic[1]).toEqual({ type: 'text.done', text: 'generic' });
    expect(provider.calls).toHaveLength(2);
  });

  /**
   * Multi-step: each `stream()` call pops the next step of the selected script, so a tool loop
   * (call → result → answer) works; when the script is exhausted an `error` event is yielded
   * instead of hanging; `reset` replays from the start.
   */
  it('pops one step per call, errors when exhausted, and can reset', async () => {
    const provider = new FakeAgentModelProvider({
      script: {
        default: toolThenAnswer({ callId: 'c1', name: 'list_dir', arguments: '{}' }, 'ok'),
      },
    });
    const first = await collect(provider.stream(input()));
    expect(first[1]?.type).toBe('tool_call');
    const second = await collect(
      provider.stream(
        input({
          items: [
            { role: 'user', content: 'hello' },
            { type: 'tool_result', callId: 'c1', output: '' },
          ],
        }),
      ),
    );
    expect(second[1]).toEqual({ type: 'text.done', text: 'ok' });
    const third = await collect(provider.stream(input()));
    expect(third).toEqual([
      {
        type: 'error',
        code: 'unknown',
        message: 'FakeAgentModelProvider: script "default" exhausted after 2 step(s)',
        retryable: false,
      },
    ]);
    provider.reset();
    const again = await collect(provider.stream(input()));
    expect(again[1]?.type).toBe('tool_call');
  });

  /**
   * No matching script and no default: an `error` event sizes the prompt so the test author sees
   * something actionable, without quoting it — the message is persisted as the turn's error and
   * a prompt may hold a pasted credential, so a canary in the prompt must not survive. A turn
   * without any user item says so explicitly.
   */
  it('yields an error event when no script matches, without quoting the prompt', async () => {
    const provider = new FakeAgentModelProvider({ script: { other: simpleAnswer('x') } });
    const events = await collect(provider.stream(input()));
    expect(events[0]).toMatchObject({ type: 'error', code: 'unknown', retryable: false });
    expect((events[0] as { message: string }).message).toContain('(5 characters)');
    expect((events[0] as { message: string }).message).not.toContain('hello');

    const secret = await collect(
      provider.stream(input({ items: [{ role: 'user', content: GITHUB_CANARY }] })),
    );
    const leaked = (secret[0] as { message: string }).message;
    expect(leaked).toContain(`(${String(GITHUB_CANARY.length)} characters)`);
    expect(() => {
      assertNoCanary(leaked);
    }).not.toThrow();

    const noUser = await collect(
      provider.stream(input({ items: [{ role: 'system', content: 's' }] })),
    );
    expect((noUser[0] as { message: string }).message).toContain('without a user message');
  });

  /**
   * Delay: events of a delayed step are withheld until `delayMs` elapses (fake timers).
   */
  it('honours per-step delayMs', async () => {
    vi.useFakeTimers();
    const provider = new FakeAgentModelProvider({
      script: { default: [{ events: simpleAnswer('late')[0]?.events ?? [], delayMs: 500 }] },
    });
    const received: ModelEvent[] = [];
    const done = (async () => {
      for await (const event of provider.stream(input())) {
        received.push(event);
      }
    })();
    await vi.advanceTimersByTimeAsync(499);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(received).toHaveLength(3);
  });

  /**
   * Abort ends the stream silently: aborting during the delay yields nothing; aborting between
   * events stops the remaining ones; no `error` event is produced in either case.
   */
  it('ends silently on abort', async () => {
    vi.useFakeTimers();
    const delayed = new FakeAgentModelProvider({
      script: { default: [{ events: simpleAnswer('x')[0]?.events ?? [], delayMs: 1000 }] },
    });
    const controller = new AbortController();
    const pending = collect(delayed.stream(input({ signal: controller.signal })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await pending).toEqual([]);

    const immediate = new FakeAgentModelProvider({ script: { default: simpleAnswer('y') } });
    const midway = new AbortController();
    const iterator = immediate.stream(input({ signal: midway.signal }))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect((first.value as ModelEvent).type).toBe('text.delta');
    midway.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  /**
   * `listModels` returns the configured ids (default `['fake-model']`) as a fresh array.
   */
  it('lists models', async () => {
    expect(await new FakeAgentModelProvider({ script: {} }).listModels()).toEqual(['fake-model']);
    const custom = new FakeAgentModelProvider({ script: {}, models: ['a', 'b'] });
    const models = await custom.listModels();
    models.push('c');
    expect(await custom.listModels()).toEqual(['a', 'b']);
  });
});
