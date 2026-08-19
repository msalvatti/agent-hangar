/**
 * Unit tests of `OpenAIModelProvider`.
 *
 * Layer: test.
 *
 * Every committed fixture is replayed through the fake client and compared with the exact event
 * sequence the agent runtime is entitled to receive, so a change in the mapping shows up here as a
 * diff rather than as a subtly different transcript.
 */
import { inspect } from 'node:util';

import { APIError } from 'openai/core/error';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import { AgentHangarError } from '../../errors.js';
import { OPENAI_CANARY, assertNoCanary } from '../../testing/canaries.js';
import type { ModelEvent, ModelTurnInput } from '../types.js';

import { ModelProviderError } from './errors.js';
import { createFakeOpenAIClient } from './fake-client.js';
import { loadOpenAIFixture } from './fixtures.js';
import { createOpenAIModelProvider } from './provider.js';

/** Usage every completed fixture reports. */
const USAGE = { inputTokens: 120, outputTokens: 18 };

/** Turn input used wherever the test does not assert on the request. */
const INPUT: ModelTurnInput = {
  model: 'gpt-5.6-sol',
  instructions: 'You are a coding agent.',
  items: [{ role: 'user', content: 'hello' }],
  tools: [],
};

/**
 * Drains a model stream.
 *
 * @param source - The provider stream to consume.
 * @returns Every event it yielded, in order.
 */
async function collect(source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

/**
 * Replays one fixture through the provider.
 *
 * @param name - Fixture to replay.
 * @returns Everything the provider yielded.
 */
async function replayFixture(name: Parameters<typeof loadOpenAIFixture>[0]): Promise<ModelEvent[]> {
  const client = createFakeOpenAIClient({ events: await loadOpenAIFixture(name) });
  return collect(createOpenAIModelProvider({ client }).stream(INPUT));
}

/** A text delta as the fake replays it, for streams assembled inside a test. */
const TEXT_DELTA: ResponseStreamEvent = {
  type: 'response.output_text.delta',
  content_index: 0,
  delta: 'x',
  item_id: 'msg_1',
  logprobs: [],
  output_index: 0,
  sequence_number: 0,
};

describe('OpenAIModelProvider', () => {
  it('is registered under the name openai', () => {
    // The registry and the configuration schema key on this exact string.
    expect(createOpenAIModelProvider({ client: createFakeOpenAIClient() }).name).toBe('openai');
  });

  it('turns a plain answer into deltas, the final text and one response.done', async () => {
    // The transcript renders the deltas live and stores the finalised text once.
    expect(await replayFixture('text')).toEqual([
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.delta', text: ', ' },
      { type: 'text.delta', text: 'world.' },
      { type: 'text.done', text: 'Hello, world.' },
      {
        type: 'response.done',
        responseId: 'resp_6f2a1c9b47e8d05a3b12c4d7',
        usage: USAGE,
      },
    ]);
  });

  it('turns a tool call into argument deltas keyed by call id and one tool_call', async () => {
    // The runtime executes the tool by call_id, and echoes the result back under the same id.
    expect(await replayFixture('tool-call')).toEqual([
      { type: 'tool_call.arguments.delta', callId: 'call_7a8b9c0d1e2f3a4b', delta: '{"command"' },
      { type: 'tool_call.arguments.delta', callId: 'call_7a8b9c0d1e2f3a4b', delta: ': "ls -la"' },
      { type: 'tool_call.arguments.delta', callId: 'call_7a8b9c0d1e2f3a4b', delta: '}' },
      {
        type: 'tool_call',
        callId: 'call_7a8b9c0d1e2f3a4b',
        name: 'run_shell',
        arguments: '{"command": "ls -la"}',
      },
      {
        type: 'response.done',
        responseId: 'resp_8b7c6d5e4f3a2b1c0d9e8f70',
        usage: USAGE,
      },
    ]);
  });

  it('keeps text and a tool call of the same response in order', async () => {
    // A step may both say something and act; the transcript must show it in that order.
    expect(await replayFixture('text-and-tool-call')).toEqual([
      { type: 'text.delta', text: 'Let me check.' },
      { type: 'text.done', text: 'Let me check.' },
      {
        type: 'tool_call.arguments.delta',
        callId: 'call_1f2e3d4c5b6a7988',
        delta: '{"path":"NOTES.md",',
      },
      {
        type: 'tool_call.arguments.delta',
        callId: 'call_1f2e3d4c5b6a7988',
        delta: '"content":"hi"}',
      },
      {
        type: 'tool_call',
        callId: 'call_1f2e3d4c5b6a7988',
        name: 'write_file',
        arguments: '{"path":"NOTES.md","content":"hi"}',
      },
      {
        type: 'response.done',
        responseId: 'resp_1a2b3c4d5e6f708192a3b4c5',
        usage: USAGE,
      },
    ]);
  });

  it('delivers a refusal as assistant text', async () => {
    // A refusal is an answer the user has to read, not an error the runtime should retry.
    expect(await replayFixture('refusal')).toEqual([
      { type: 'text.delta', text: 'I cannot help ' },
      { type: 'text.delta', text: 'with that request.' },
      { type: 'text.done', text: 'I cannot help with that request.' },
      {
        type: 'response.done',
        responseId: 'resp_c4d5e6f708192a3b4c5d6e7f',
        usage: USAGE,
      },
    ]);
  });

  it('turns a failed response into a single retryable error', async () => {
    // Nothing may follow a terminal event, even if the stream had more to say.
    expect(await replayFixture('failed')).toEqual([
      {
        type: 'error',
        code: 'rate_limit',
        message: 'Rate limit reached for requests',
        retryable: true,
      },
    ]);
  });

  it('completes a response cut off by the output-token cap', async () => {
    // An incomplete response still produced output; the step ends, the turn continues.
    expect(await replayFixture('incomplete')).toEqual([
      { type: 'text.delta', text: 'Counting: 1, 2, 3, ' },
      { type: 'text.delta', text: '4, 5, 6, ' },
      {
        type: 'response.done',
        responseId: 'resp_9e8d7c6b5a4938271605f4e3',
        usage: USAGE,
      },
    ]);
  });

  it('turns a stream-level error event into a single error', async () => {
    // A transport error arrives as a stream event rather than as a thrown exception.
    expect(await replayFixture('error-event')).toEqual([
      {
        type: 'error',
        code: 'unknown',
        message: 'The server had an error while processing your request',
        retryable: false,
      },
    ]);
  });

  it('sends a stateless request carrying the input model, the tools and the signal', async () => {
    // The request is the contract with the API: no stored state, strict tools, caller's model id.
    const controller = new AbortController();
    const client = createFakeOpenAIClient();
    const input: ModelTurnInput = {
      ...INPUT,
      model: 'gpt-5.6-mini',
      tools: [{ name: 'run_shell', description: 'Runs a command.', parameters: {} }],
      signal: controller.signal,
    };
    await collect(createOpenAIModelProvider({ client }).stream(input));
    const call = client.calls.stream[0];
    expect(call?.params.store).toBe(false);
    expect(call?.params.model).toBe('gpt-5.6-mini');
    expect(Object.keys(call?.params ?? {})).not.toContain('previous_response_id');
    expect(call?.params.tools?.[0]).toMatchObject({ name: 'run_shell', strict: true });
    expect(call?.options?.signal).toBe(controller.signal);
  });

  it('reports a failure raised before the first event and yields nothing else', async () => {
    // A bad key fails the request itself; the turn must end with one classified error.
    const client = createFakeOpenAIClient({
      events: [TEXT_DELTA],
      throwBeforeStream: new APIError(
        401,
        { message: 'Incorrect API key' },
        undefined,
        new Headers(),
      ),
    });
    expect(await collect(createOpenAIModelProvider({ client }).stream(INPUT))).toEqual([
      { type: 'error', code: 'auth', message: '401 Incorrect API key', retryable: false },
    ]);
  });

  it('keeps the events delivered before a mid-stream failure', async () => {
    // Text the user already saw stays in the transcript; the error is appended to it.
    const client = createFakeOpenAIClient({
      events: [TEXT_DELTA, TEXT_DELTA, TEXT_DELTA],
      throwAfterEvents: {
        count: 2,
        error: new APIError(429, { message: 'Rate limit reached' }, undefined, new Headers()),
      },
    });
    expect(await collect(createOpenAIModelProvider({ client }).stream(INPUT))).toEqual([
      { type: 'text.delta', text: 'x' },
      { type: 'text.delta', text: 'x' },
      { type: 'error', code: 'rate_limit', message: '429 Rate limit reached', retryable: true },
    ]);
  });

  it('ends silently when the turn is cancelled mid-stream', async () => {
    // A cancellation is a user action; recording it as a failed turn would be wrong.
    const controller = new AbortController();
    const client = createFakeOpenAIClient({
      events: [TEXT_DELTA, TEXT_DELTA, TEXT_DELTA],
      delayMs: 1,
    });
    const events: ModelEvent[] = [];
    for await (const event of createOpenAIModelProvider({ client }).stream({
      ...INPUT,
      signal: controller.signal,
    })) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([{ type: 'text.delta', text: 'x' }]);
  });

  it('ends silently when the stream finishes after the turn was cancelled', async () => {
    // The signal, not the absence of a terminal event, decides whether this was a failure.
    const controller = new AbortController();
    controller.abort();
    const client = createFakeOpenAIClient({ events: [] });
    const events = await collect(
      createOpenAIModelProvider({ client }).stream({ ...INPUT, signal: controller.signal }),
    );
    expect(events).toEqual([]);
  });

  it('ends silently when the transport reports a cancellation without a signal', async () => {
    // Nothing is yielded for an abort-shaped error, whoever raised it.
    const aborted = new Error('Request was aborted.');
    aborted.name = 'AbortError';
    const client = createFakeOpenAIClient({ throwBeforeStream: aborted });
    expect(await collect(createOpenAIModelProvider({ client }).stream(INPUT))).toEqual([]);
  });

  it('reports a stream that ended without a terminal event as retryable', async () => {
    // Otherwise the turn would hang waiting for a completion that never arrives.
    const client = createFakeOpenAIClient({ events: [TEXT_DELTA] });
    expect(await collect(createOpenAIModelProvider({ client }).stream(INPUT))).toEqual([
      { type: 'text.delta', text: 'x' },
      {
        type: 'error',
        code: 'unknown',
        message: 'stream ended without completion',
        retryable: true,
      },
    ]);
  });

  it('yields nothing after the terminal event', async () => {
    // A stream that keeps talking after `response.completed` must not extend the turn.
    const fixture = await loadOpenAIFixture('text');
    const client = createFakeOpenAIClient({ events: [...fixture, TEXT_DELTA] });
    const events = await collect(createOpenAIModelProvider({ client }).stream(INPUT));
    expect(events.at(-1)).toEqual({
      type: 'response.done',
      responseId: 'resp_6f2a1c9b47e8d05a3b12c4d7',
      usage: USAGE,
    });
    expect(events).toHaveLength(5);
  });

  it('lists model ids sorted ascending', async () => {
    // Settings shows the list; a stable order keeps the UI from reshuffling between loads.
    const client = createFakeOpenAIClient({ models: ['zeta', 'alpha', 'mid'] });
    await expect(createOpenAIModelProvider({ client }).listModels()).resolves.toEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('turns a failed listing into a typed provider error', async () => {
    // Settings needs the category to tell "wrong key" from "service down".
    const client = createFakeOpenAIClient({
      throwOnListModels: new APIError(
        401,
        { message: 'Incorrect API key' },
        undefined,
        new Headers(),
      ),
    });
    const failure = await createOpenAIModelProvider({ client })
      .listModels()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toBeInstanceOf(AgentHangarError);
    expect(failure).toMatchObject({
      code: 'MODEL_PROVIDER_ERROR',
      modelErrorCode: 'auth',
      retryable: false,
      message: '401 Incorrect API key',
    });
  });

  it('never lets the SDK error carry a credential out of a failed listing', async () => {
    // The API echoes part of the submitted key on some auth failures. Redacting only the message
    // would be undone by any consumer that walks the cause chain, so no cause is attached at all.
    const client = createFakeOpenAIClient({
      throwOnListModels: new APIError(
        401,
        { message: `Incorrect API key provided: ${OPENAI_CANARY}` },
        undefined,
        new Headers(),
      ),
    });
    const failure = await createOpenAIModelProvider({ client })
      .listModels()
      .catch((error: unknown) => error);
    expect((failure as ModelProviderError).message).toBe(
      '401 Incorrect API key provided: [REDACTED]',
    );
    expect((failure as ModelProviderError).cause).toBeUndefined();
    assertNoCanary(inspect(failure, { depth: null }));
  });

  it('turns a cancelled listing into a typed provider error too', async () => {
    // `listModels` has no stream to end silently, so a cancellation still has to be reported.
    const aborted = new Error('Request was aborted.');
    aborted.name = 'AbortError';
    const client = createFakeOpenAIClient({ throwOnListModels: aborted });
    const failure = await createOpenAIModelProvider({ client })
      .listModels()
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      modelErrorCode: 'unknown',
      retryable: false,
      message: 'model listing aborted',
    });
  });
});
