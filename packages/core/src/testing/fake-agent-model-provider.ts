/**
 * Scripted `AgentModelProvider` for tests: plays `ModelEvent` steps keyed by the last user
 * message, one step per `stream()` call, so multi-step tool loops can be exercised.
 *
 * Layer: test double.
 *
 * Abort semantics: when `input.signal` aborts, the stream ends silently — no `error` event is
 * yielded — mirroring a cancelled HTTP stream. Delays use real timers; tests use fake timers.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { AgentModelProvider, ModelEvent, ModelTurnInput, ModelUsage } from '../model/types.js';

/** One model round-trip of a script. */
export interface ScriptedStep {
  /** Events yielded in order; normally ends with `response.done` or `error`. */
  events: ModelEvent[];
  /** Delay before the first event, in ms (fake timers recommended). */
  delayMs?: number;
}

/**
 * Steps keyed by the exact text of the last `user` item; the `default` key applies when no
 * other key matches.
 */
export type ProviderScript = Record<string, ScriptedStep[]>;

/** Constructor options. */
export interface FakeAgentModelProviderOptions {
  script: ProviderScript;
  /** Ids returned by `listModels()`; defaults to `['fake-model']`. */
  models?: string[];
}

/** Tool call described by `toolThenAnswer`. */
export interface ScriptedToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/** Usage attached to every scripted `response.done`. */
export const FAKE_USAGE: ModelUsage = { inputTokens: 10, outputTokens: 5 };

/** Builds a one-step script that answers with `text`. */
export function simpleAnswer(text: string): ScriptedStep[] {
  return [
    {
      events: [
        { type: 'text.delta', text },
        { type: 'text.done', text },
        { type: 'response.done', responseId: `fake-${text.length.toString()}`, usage: FAKE_USAGE },
      ],
    },
  ];
}

/** Builds a two-step script: a tool call, then the final answer once the result is fed back. */
export function toolThenAnswer(toolCall: ScriptedToolCall, answerText: string): ScriptedStep[] {
  return [
    {
      events: [
        { type: 'tool_call.arguments.delta', callId: toolCall.callId, delta: toolCall.arguments },
        { type: 'tool_call', ...toolCall },
        { type: 'response.done', responseId: `fake-tool-${toolCall.callId}`, usage: FAKE_USAGE },
      ],
    },
    ...simpleAnswer(answerText),
  ];
}

function lastUserText(input: ModelTurnInput): string | undefined {
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const item = input.items[index];
    if (item !== undefined && 'role' in item && item.role === 'user') {
      return item.content;
    }
  }
  return undefined;
}

/** Fake provider; `name` is `"fake"`. */
export class FakeAgentModelProvider implements AgentModelProvider {
  readonly name = 'fake';
  /** Every `stream()` input in order, for assertions. */
  readonly calls: ModelTurnInput[] = [];

  private readonly script: ProviderScript;
  private readonly cursors = new Map<string, number>();
  private readonly models: string[];

  constructor(options: FakeAgentModelProviderOptions) {
    this.script = options.script;
    this.models = options.models ?? ['fake-model'];
  }

  /** Plays the next step of the script selected by the last user message (or `default`). */
  async *stream(input: ModelTurnInput): AsyncIterable<ModelEvent> {
    this.calls.push(input);
    const selected = this.selectScript(input);
    if (selected === undefined) {
      yield {
        type: 'error',
        code: 'unknown',
        message: `FakeAgentModelProvider: no script for prompt ${JSON.stringify(lastUserText(input) ?? null)} and no default`,
        retryable: false,
      };
      return;
    }
    const { key, steps } = selected;
    const position = this.cursors.get(key) ?? 0;
    const step = steps[position];
    if (step === undefined) {
      yield {
        type: 'error',
        code: 'unknown',
        message: `FakeAgentModelProvider: script "${key}" exhausted after ${String(steps.length)} step(s)`,
        retryable: false,
      };
      return;
    }
    this.cursors.set(key, position + 1);
    if (step.delayMs !== undefined && step.delayMs > 0) {
      try {
        await sleep(step.delayMs, undefined, { signal: input.signal });
      } catch {
        return;
      }
    }
    for (const event of step.events) {
      if (input.signal?.aborted === true) {
        return;
      }
      yield event;
    }
  }

  /** Configured model ids (`['fake-model']` by default). */
  async listModels(): Promise<string[]> {
    await Promise.resolve();
    return [...this.models];
  }

  /** Resets every script cursor so steps replay from the beginning. */
  reset(): void {
    this.cursors.clear();
  }

  private selectScript(input: ModelTurnInput): { key: string; steps: ScriptedStep[] } | undefined {
    const text = lastUserText(input);
    const candidates = text === undefined ? ['default'] : [text, 'default'];
    for (const key of candidates) {
      // `hasOwn` keeps prototype names ("constructor", "toString") from matching a script.
      const steps = Object.hasOwn(this.script, key) ? this.script[key] : undefined;
      if (steps !== undefined) {
        return { key, steps };
      }
    }
    return undefined;
  }
}
