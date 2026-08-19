/**
 * `AgentModelProvider` over the OpenAI Responses streaming endpoint.
 *
 * Layer: service (adapter).
 *
 * A thin loop around the pure mapping layer: build the request, iterate the SDK stream, translate
 * each event, and guarantee the contract the agent runtime relies on — the iterable always ends,
 * it yields at most one terminal event, and nothing follows it. A cancelled turn ends silently.
 *
 * The provider never logs: the request carries the system prompt, repository content and tool
 * output, and the credential lives in the client it was handed.
 */
import type { AgentModelProvider, ModelEvent, ModelTurnInput } from '../types.js';

import type { OpenAIResponsesClient } from './client.js';
import { ModelProviderError } from './errors.js';
import { createEventMapper, mapErrorToModelEvent, toResponseParams } from './mapping.js';

/** Reported when the SDK stream ends without a terminal event, which the runtime retries. */
const STREAM_ENDED_MESSAGE = 'stream ended without completion';

/** Reported when a model listing is cancelled rather than failing. */
const LISTING_ABORTED_MESSAGE = 'model listing aborted';

/** Dependencies of {@link OpenAIModelProvider}. */
export interface OpenAIModelProviderOptions {
  /** SDK client, real or fake; the provider never constructs one itself. */
  client: OpenAIResponsesClient;
}

/** Streams one model round-trip over the Responses API. */
export class OpenAIModelProvider implements AgentModelProvider {
  readonly name = 'openai';

  private readonly client: OpenAIResponsesClient;

  /**
   * @param options - The SDK client to stream through.
   */
  constructor(options: OpenAIModelProviderOptions) {
    this.client = options.client;
  }

  /**
   * Runs one model round-trip.
   *
   * Ends with exactly one `response.done` or one `error`, except when the turn was cancelled — an
   * abort ends the iterable without an event, so a cancellation is never recorded as a failure.
   *
   * @param input - The turn to send.
   * @yields Text deltas, tool calls and the terminal event.
   */
  async *stream(input: ModelTurnInput): AsyncIterable<ModelEvent> {
    const params = toResponseParams(input);
    const mapper = createEventMapper();
    const options = input.signal === undefined ? undefined : { signal: input.signal };
    try {
      for await (const event of this.client.responses.stream(params, options)) {
        for (const mapped of mapper.map(event)) {
          yield mapped;
        }
        if (mapper.sawTerminal) {
          return;
        }
      }
    } catch (err) {
      // The signal is the authoritative record of a cancellation; the shape of the error the SDK
      // raises when a request is aborted is an implementation detail of the transport.
      if (input.signal?.aborted !== true) {
        const mapped = mapErrorToModelEvent(err);
        if (mapped !== null) {
          yield mapped;
        }
      }
      return;
    }
    if (input.signal?.aborted !== true) {
      yield { type: 'error', code: 'unknown', message: STREAM_ENDED_MESSAGE, retryable: true };
    }
  }

  /**
   * Lists the model ids the configured credential can reach.
   *
   * Used by the doctor and by Settings to validate a key and a model id without spending tokens.
   *
   * The SDK error is deliberately not attached as `cause`: its own message can echo part of the
   * submitted key, and it carries the response body and headers. Redacting only the top level
   * would be undone by any consumer that walks the cause chain — Node's inspector and the standard
   * error serialisers both do. The classified message is the whole of what leaves this method.
   *
   * @returns The ids, sorted ascending.
   * @throws ModelProviderError classified like a streamed `error` event.
   */
  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const model of this.client.models.list()) {
        ids.push(model.id);
      }
    } catch (err) {
      const mapped = mapErrorToModelEvent(err) ?? {
        code: 'unknown' as const,
        message: LISTING_ABORTED_MESSAGE,
        retryable: false,
      };
      throw new ModelProviderError(mapped.code, mapped.message, mapped.retryable);
    }
    return ids.sort();
  }
}

/**
 * Creates the OpenAI provider.
 *
 * @param options - The SDK client to stream through.
 * @returns The provider.
 */
export function createOpenAIModelProvider(
  options: OpenAIModelProviderOptions,
): OpenAIModelProvider {
  return new OpenAIModelProvider(options);
}
