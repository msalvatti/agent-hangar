/**
 * Fixture-replaying stand-in for the OpenAI SDK client.
 *
 * Layer: test double.
 *
 * The configured failures are typed as `Error` because that is what the SDK throws; a thrown
 * non-error is a case for the error mapper's own tests, not for a stream replay.
 *
 * Satisfies {@link OpenAIResponsesClient} without a network call or an API key: it replays a list
 * of recorded events, can fail before or during a stream, honours an abort signal, and records
 * every request so tests can assert what the provider sent. Delays use the global timer, so a test
 * may drive them with real or fake timers.
 */
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import type { OpenAIModelSummary, OpenAIResponsesClient, OpenAIStreamOptions } from './client.js';

/** Model ids served by `models.list()` unless the test configures its own. */
export const DEFAULT_FAKE_MODELS: readonly string[] = ['gpt-5.6-sol', 'gpt-5.6-mini'];

/** How the fake behaves for the streams and listings a test drives through it. */
export interface FakeOpenAIClientOptions {
  /** Events replayed per `stream()` call; a function is invoked once per call. */
  events?: readonly ResponseStreamEvent[] | (() => readonly ResponseStreamEvent[]);
  /** Delay before each event, in milliseconds. */
  delayMs?: number;
  /** Thrown instead of opening the stream. */
  throwBeforeStream?: Error;
  /**
   * Thrown while iterating, once the given number of events has been yielded. A `count` at or
   * beyond the length of the stream fails when the stream runs out, so a failure-path test can
   * never silently degrade into an ordinary exhaustion.
   */
  throwAfterEvents?: { count: number; error: Error };
  /** Model ids served by `models.list()`. */
  models?: readonly string[];
  /** Thrown instead of listing models. */
  throwOnListModels?: Error;
}

/** What the fake recorded about the calls it received. */
export interface FakeOpenAIClientCalls {
  /** One entry per `responses.stream()` call, in order. */
  stream: { params: ResponseCreateParamsStreaming; options: OpenAIStreamOptions | undefined }[];
  /** Number of `models.list()` calls. */
  listModels: number;
}

/** Fake client with the recorded calls exposed for assertions. */
export interface FakeOpenAIClient extends OpenAIResponsesClient {
  /** Requests the fake received. */
  readonly calls: FakeOpenAIClientCalls;
}

/**
 * Builds the error an aborted request raises.
 *
 * The name is what both the platform and the SDK use, and what the error mapper recognises.
 *
 * @returns The abort error.
 */
function createAbortError(): Error {
  const error = new Error('Request was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Waits, rejecting as soon as the signal aborts instead of after the full delay.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Signal that cancels the wait, when the caller passed one.
 * @returns A promise that settles when the delay elapses or the signal aborts.
 */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Replays the configured events for one `stream()` call.
 *
 * @param options - Behaviour configured for the fake.
 * @param streamOptions - Options the caller passed to `stream()`.
 * @yields The recorded events, in order.
 */
async function* replay(
  options: FakeOpenAIClientOptions,
  streamOptions: OpenAIStreamOptions | undefined,
): AsyncGenerator<ResponseStreamEvent> {
  if (options.throwBeforeStream !== undefined) {
    throw options.throwBeforeStream;
  }
  const source = options.events ?? [];
  const events = typeof source === 'function' ? source() : source;
  for (const [index, event] of events.entries()) {
    if (options.throwAfterEvents?.count === index) {
      throw options.throwAfterEvents.error;
    }
    if (streamOptions?.signal?.aborted === true) {
      throw createAbortError();
    }
    if (options.delayMs !== undefined) {
      await wait(options.delayMs, streamOptions?.signal);
    }
    yield event;
  }
  if (options.throwAfterEvents !== undefined) {
    // Reached only when the count was never hit inside the loop, i.e. it is at or beyond the
    // length of the stream. Failing here keeps `throwAfterEvents` from becoming a silent no-op.
    throw options.throwAfterEvents.error;
  }
}

/**
 * Serves the configured model ids for one `models.list()` call.
 *
 * @param options - Behaviour configured for the fake.
 * @yields One summary per configured model id.
 */
async function* listModels(options: FakeOpenAIClientOptions): AsyncGenerator<OpenAIModelSummary> {
  // The real listing is a paginated request; the tick keeps the generator genuinely asynchronous.
  await Promise.resolve();
  if (options.throwOnListModels !== undefined) {
    throw options.throwOnListModels;
  }
  for (const id of options.models ?? DEFAULT_FAKE_MODELS) {
    yield { id };
  }
}

/**
 * Creates a fake SDK client.
 *
 * @param options - Behaviour for the streams and listings the test drives; defaults to an empty
 *   stream and the two default model ids.
 * @returns The fake client, with its recorded calls.
 */
export function createFakeOpenAIClient(options: FakeOpenAIClientOptions = {}): FakeOpenAIClient {
  const calls: FakeOpenAIClientCalls = { stream: [], listModels: 0 };
  return {
    calls,
    responses: {
      stream(
        params: ResponseCreateParamsStreaming,
        streamOptions?: OpenAIStreamOptions,
      ): AsyncIterable<ResponseStreamEvent> {
        calls.stream.push({ params, options: streamOptions });
        return replay(options, streamOptions);
      },
    },
    models: {
      list(): AsyncIterable<OpenAIModelSummary> {
        calls.listModels += 1;
        return listModels(options);
      },
    },
  };
}
