/**
 * The narrow slice of the OpenAI SDK client the model provider depends on.
 *
 * Layer: service (port).
 *
 * Declaring the dependency structurally keeps the provider testable without the SDK: the real
 * client satisfies this interface, and so does the fixture-replaying fake. A type-level test
 * asserts the real client stays assignable, so the interface cannot silently drift from the SDK.
 */
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

/** Per-request options forwarded to the SDK. */
export interface OpenAIStreamOptions {
  /** Aborting ends the stream; the provider reports no error for a cancellation. */
  signal?: AbortSignal;
}

/** One entry of the model listing. */
export interface OpenAIModelSummary {
  /** Model id, e.g. `gpt-5.6-sol`. */
  id: string;
}

/** Structural subset of the SDK client used by {@link OpenAIModelProvider}. */
export interface OpenAIResponsesClient {
  /** Responses API surface. */
  responses: {
    /**
     * Opens a streaming response.
     *
     * @param params - Request parameters built by `toResponseParams`.
     * @param options - Per-request options, notably the abort signal.
     * @returns The stream of raw SDK events.
     */
    stream(
      params: ResponseCreateParamsStreaming,
      options?: OpenAIStreamOptions,
    ): AsyncIterable<ResponseStreamEvent>;
  };
  /** Models API surface. */
  models: {
    /**
     * Lists the models the credential can reach; the SDK paginates transparently.
     *
     * @returns An async iterable of model summaries.
     */
    list(): AsyncIterable<OpenAIModelSummary>;
  };
}
