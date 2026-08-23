/**
 * Unit tests of the fixture-replaying fake SDK client.
 *
 * Layer: test.
 *
 * Delays are exercised with real one-millisecond timers rather than fake ones: the fake is consumed
 * through an async iterator, and a real timer keeps the interleaving of `next()` and `abort()`
 * exactly what a caller would see.
 */
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import type { OpenAIModelSummary } from './client.ts';
import { DEFAULT_FAKE_MODELS, createFakeOpenAIClient } from './fake-client.ts';
import { toResponseParams } from './mapping.ts';

/** Two cheap events, enough to observe ordering and mid-stream failures. */
const EVENTS: ResponseStreamEvent[] = [
  {
    type: 'response.output_text.delta',
    content_index: 0,
    delta: 'a',
    item_id: 'msg_1',
    logprobs: [],
    output_index: 0,
    sequence_number: 0,
  },
  {
    type: 'response.output_text.delta',
    content_index: 0,
    delta: 'b',
    item_id: 'msg_1',
    logprobs: [],
    output_index: 0,
    sequence_number: 1,
  },
];

/** Request parameters used wherever the test does not assert on them. */
const PARAMS = toResponseParams({
  model: 'gpt-5.6-sol',
  instructions: 'be brief',
  items: [],
  tools: [],
});

/**
 * Drains an async iterable.
 *
 * @param source - The stream to consume.
 * @returns Everything it yielded, in order.
 */
async function drain(source: AsyncIterable<ResponseStreamEvent>): Promise<ResponseStreamEvent[]> {
  const collected: ResponseStreamEvent[] = [];
  for await (const event of source) {
    collected.push(event);
  }
  return collected;
}

describe('createFakeOpenAIClient', () => {
  it('replays the configured events in order and records the request', () => {
    // Provider tests assert on both the events they receive and the parameters that were sent.
    const client = createFakeOpenAIClient({ events: EVENTS });
    const options = { signal: new AbortController().signal };
    return drain(client.responses.stream(PARAMS, options)).then((events) => {
      expect(events).toEqual(EVENTS);
      expect(client.calls.stream).toEqual([{ params: PARAMS, options }]);
    });
  });

  it('records a stream opened without options', async () => {
    // The provider omits the options object entirely when the turn carries no signal.
    const client = createFakeOpenAIClient();
    expect(await drain(client.responses.stream(PARAMS))).toEqual([]);
    expect(client.calls.stream[0]?.options).toBeUndefined();
  });

  it('calls the event factory once per stream', async () => {
    // A shared array would let one test's consumption affect the next stream.
    let calls = 0;
    const client = createFakeOpenAIClient({
      events: () => {
        calls += 1;
        return EVENTS.slice(0, 1);
      },
    });
    await drain(client.responses.stream(PARAMS));
    await drain(client.responses.stream(PARAMS));
    expect(calls).toBe(2);
  });

  it('delays each event without a signal', async () => {
    // Covers the timer path a test uses to interleave work with the stream.
    const client = createFakeOpenAIClient({ events: EVENTS, delayMs: 1 });
    expect(await drain(client.responses.stream(PARAMS))).toEqual(EVENTS);
  });

  it('throws before yielding anything when configured to fail early', async () => {
    // Models the SDK rejecting the request itself, for instance on a bad key.
    const client = createFakeOpenAIClient({
      events: EVENTS,
      throwBeforeStream: new Error('boom'),
    });
    await expect(drain(client.responses.stream(PARAMS))).rejects.toThrow('boom');
  });

  it('throws mid-stream after the configured number of events', async () => {
    // Models a connection dropping once deltas have already reached the caller.
    const client = createFakeOpenAIClient({
      events: EVENTS,
      throwAfterEvents: { count: 1, error: new Error('dropped') },
    });
    const iterator = client.responses.stream(PARAMS)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(EVENTS[0]);
    await expect(iterator.next()).rejects.toThrow('dropped');
  });

  it('still throws when the count reaches the end of the stream', async () => {
    // A count at or beyond the length of the stream used to end it normally, which turned a
    // failure-path test into an assertion about ordinary exhaustion.
    const atEnd = createFakeOpenAIClient({
      events: EVENTS,
      throwAfterEvents: { count: EVENTS.length, error: new Error('dropped at the end') },
    });
    await expect(drain(atEnd.responses.stream(PARAMS))).rejects.toThrow('dropped at the end');
    const empty = createFakeOpenAIClient({
      throwAfterEvents: { count: 0, error: new Error('dropped immediately') },
    });
    await expect(drain(empty.responses.stream(PARAMS))).rejects.toThrow('dropped immediately');
  });

  it('refuses to yield anything when the signal is already aborted', async () => {
    // A turn cancelled before the request went out must not replay a single event.
    const controller = new AbortController();
    controller.abort();
    const client = createFakeOpenAIClient({ events: EVENTS });
    await expect(
      drain(client.responses.stream(PARAMS, { signal: controller.signal })),
    ).rejects.toThrow('Request was aborted.');
  });

  it('interrupts a pending delay as soon as the signal aborts', async () => {
    // Without the abort listener a cancelled turn would still wait out the delay.
    const controller = new AbortController();
    const client = createFakeOpenAIClient({ events: EVENTS, delayMs: 60_000 });
    const pending = drain(client.responses.stream(PARAMS, { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('lists the default model ids', async () => {
    // The registry and the doctor call this to validate a key without sending a prompt.
    const client = createFakeOpenAIClient();
    const ids: string[] = [];
    for await (const model of client.models.list()) {
      ids.push(model.id);
    }
    expect(ids).toEqual([...DEFAULT_FAKE_MODELS]);
    expect(client.calls.listModels).toBe(1);
  });

  it('lists the configured model ids', async () => {
    // Tests that assert on sorting need to control the order the API returns.
    const client = createFakeOpenAIClient({ models: ['zeta', 'alpha'] });
    const ids: string[] = [];
    for await (const model of client.models.list()) {
      ids.push(model.id);
    }
    expect(ids).toEqual(['zeta', 'alpha']);
  });

  it('fails the listing when configured to', async () => {
    // Models an unusable key, which the provider has to turn into a typed error.
    const client = createFakeOpenAIClient({ throwOnListModels: new Error('no access') });
    const iterator = client.models.list()[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('no access');
  });
});

describe('what the fake client answers with', () => {
  /** The two ids every suite that does not configure its own is written against. */
  it('lists the default models', async () => {
    const listed: OpenAIModelSummary[] = [];
    for await (const model of createFakeOpenAIClient().models.list()) {
      listed.push(model);
    }

    expect(listed).toStrictEqual([{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-mini' }]);
    expect(DEFAULT_FAKE_MODELS).toStrictEqual(['gpt-5.6-sol', 'gpt-5.6-mini']);
  });

  /**
   * Stream options without a signal are ordinary: a caller that passes a model and nothing else
   * has no cancellation to offer, and reading through the missing signal would turn every such
   * call into a type error.
   */
  it('streams for a caller that offered no cancellation', async () => {
    const client = createFakeOpenAIClient({ events: EVENTS });

    expect(await drain(client.responses.stream(PARAMS, {}))).toEqual(EVENTS);
  });

  /**
   * A configured delay is waited out between events, and the wait is what a cancellation
   * interrupts: a delay that never settles leaves the stream hanging, and one that is not waited
   * for makes every timing test meaningless.
   */
  it('waits the configured delay between events and stops when cancelled', async () => {
    const client = createFakeOpenAIClient({ events: [...EVENTS, ...EVENTS], delayMs: 40 });
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 10);

    const drain = async (): Promise<void> => {
      for await (const _event of client.responses.stream(PARAMS, {
        signal: controller.signal,
      })) {
        // Each event is awaited for its delay; the abort lands inside the first one.
      }
    };

    await expect(drain()).rejects.toThrow();
  });
});
