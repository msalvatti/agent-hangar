/**
 * Pure mapping between the `AgentModelProvider` contract and the OpenAI Responses API.
 *
 * Layer: service (adapter, side-effect free).
 *
 * Verified against `openai@7.5.0`: every event type string in {@link VERIFIED_EVENT_TYPES} and
 * {@link LIFECYCLE_EVENT_TYPES} is checked at compile time against the SDK's `ResponseStreamEvent`
 * union, so an upstream rename fails `tsc` here instead of silently dropping events at runtime.
 *
 * Two shipped-type details the mapping has to accommodate:
 * - `ResponseFunctionToolCall.id` is optional, so `response.output_item.added` falls back to
 *   `call_id` as the correlation key.
 * - `ResponseError.code` is a closed union with no context-length member, so a context-length
 *   failure is only recognisable on a thrown `APIError`.
 *
 * The module imports SDK **types** only. The `APIError` hierarchy is therefore recognised by the
 * own properties its constructor always sets rather than by `instanceof`, which also keeps the
 * classification correct when two copies of the SDK end up in the dependency tree.
 *
 * **No foreign text becomes a `ModelEvent`.** An `error` event's message is assembled from
 * {@link ERROR_MESSAGES} and the numeric HTTP status; the text of an SDK error, of a
 * `response.failed` and of a stream `error` event is read to classify the failure and then
 * dropped. Those strings are written by the endpoint, which `OPENAI_BASE_URL` makes configurable,
 * and they land in a persisted, displayed turn error — so a credential in one of them cannot be
 * matched away by a pattern list that has never seen the credential's shape.
 */
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseError,
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';

import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../../secrets/types.ts';
import type {
  ConversationItem,
  ModelErrorCode,
  ModelEvent,
  ModelTurnInput,
  ModelUsage,
  ToolDefinition,
} from '../types.ts';

/** The `error` member of {@link ModelEvent}. */
export type ModelErrorEvent = Extract<ModelEvent, { type: 'error' }>;

/**
 * Event types this mapper turns into {@link ModelEvent}s.
 *
 * Typed against the SDK union so a renamed event breaks the build rather than the product.
 */
export const VERIFIED_EVENT_TYPES = [
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.function_call_arguments.delta',
  'response.completed',
  'response.incomplete',
  'response.failed',
  'error',
] as const satisfies readonly ResponseStreamEvent['type'][];

/**
 * Event types a real stream also emits and this mapper deliberately ignores.
 *
 * Listed so recorded fixtures can be validated against the full set of types they may contain.
 */
export const LIFECYCLE_EVENT_TYPES = [
  'response.created',
  'response.in_progress',
  'response.content_part.added',
  'response.content_part.done',
  'response.function_call_arguments.done',
] as const satisfies readonly ResponseStreamEvent['type'][];

/** Marks a 400 as a context-length overflow when no machine-readable code is present. */
const CONTEXT_LENGTH_MESSAGE = /context length|maximum context|too many tokens/i;

/** Node surfaces a failed connection as `TypeError: fetch failed`. */
const FETCH_FAILED_MESSAGE = /fetch failed/i;

/**
 * The whole vocabulary an `error` {@link ModelEvent} message is built from.
 *
 * Nothing outside this object — and the numeric HTTP status — ever reaches a message. See
 * {@link mapErrorToModelEvent} for why the provider's own text is the only text it reports.
 */
const ERROR_MESSAGES = {
  /** The credential was rejected. */
  auth: 'authentication failed',
  /** The provider asked the caller to slow down. */
  rateLimit: 'rate limit exceeded',
  /** The request did not fit the model's context window. */
  contextLength: 'request exceeds the model context window',
  /** The request never reached the provider. */
  network: 'the request did not reach the model provider',
  /** The provider refused the request for a reason with no category of its own. */
  rejected: 'the model provider rejected the request',
  /** The provider failed on its side. */
  providerFailed: 'the model provider failed',
  /** The stream carried an `error` event. */
  streamError: 'the model stream reported an error',
  /** The response ended in `failed`. */
  responseFailed: 'the model response failed',
  /** Nothing about the failure could be classified. */
  unknown: 'unknown error',
} as const;

/** Own properties the SDK's `APIError` constructor sets on every instance, including subclasses. */
interface SdkApiErrorShape extends Error {
  /** HTTP status; `undefined` for connection and user-abort errors. */
  readonly status: unknown;
  /** Response headers; `undefined` for connection and user-abort errors. */
  readonly headers: unknown;
  /** Request id echoed by the API; `undefined` when there was no response. */
  readonly requestID: unknown;
  /** Machine-readable error code from the response body, when the API sent one. */
  readonly code?: unknown;
}

/**
 * Narrows a caught value to the SDK's `APIError` hierarchy structurally.
 *
 * @param value - Anything caught around an SDK call.
 * @returns `true` when the value carries the properties `APIError` always defines.
 */
function isSdkApiError(value: unknown): value is SdkApiErrorShape {
  return value instanceof Error && 'status' in value && 'headers' in value && 'requestID' in value;
}

/**
 * Identifiers a cancelled request carries: the platform's `AbortError` sets `name`, while the
 * SDK's `APIUserAbortError` inherits `name === 'Error'` and is only distinguishable by its class.
 */
const ABORT_ERROR_NAMES: readonly string[] = ['AbortError', 'APIUserAbortError'];

/**
 * Detects a cancellation so the caller can end the stream without surfacing an error.
 *
 * The SDK raises `APIUserAbortError` whenever the underlying request is aborted, including when a
 * consumer stops iterating early — that is, without the caller's own signal being aborted. Reading
 * it as a transport failure would let the agent runtime retry a request somebody cancelled, so it
 * is recognised here. The class is matched by its constructor name rather than by `instanceof`:
 * this module holds SDK **types** only and must not load the package at runtime.
 *
 * @param value - Anything caught around an SDK call.
 * @returns `true` for a platform `AbortError` and for the SDK's `APIUserAbortError`.
 */
function isAbortError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (ABORT_ERROR_NAMES.includes(value.name) || ABORT_ERROR_NAMES.includes(value.constructor.name))
  );
}

/**
 * Replaces credential-shaped substrings with the redaction token.
 *
 * The last gate every `error` {@link ModelEvent} message passes through. Since no text from the
 * SDK, the server or the platform is copied into a message any more, it has nothing to strip in
 * normal operation — it is kept, and applied unconditionally, so that reintroducing a forwarded
 * string somewhere cannot silently reintroduce a leak with it. It is the seam `createRedactor`
 * from `src/redaction/` slots into, which is why it is exported and covered directly rather than
 * only through the paths that call it; that swap is a change of its own, not of this one, because
 * the shared redactor also registers exact values and this module holds no credential to register.
 *
 * On its own it is *not* sufficient, which is the reason the messages became controlled: a shape
 * list cannot match a credential whose shape it does not know, and `OPENAI_BASE_URL` exists so a
 * compatible gateway with a completely different key format can be used.
 *
 * The shared patterns carry no `g` flag, so each one is applied until it no longer matches; every
 * pattern is longer than its replacement, so the text strictly shrinks and the loop terminates.
 *
 * @param message - Message about to become an `error` event.
 * @returns The message with every credential shape replaced.
 */
export function redactSecretShapes(message: string): string {
  let result = message;
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    while (pattern.test(result)) {
      result = result.replace(pattern, REDACTED_TOKEN);
    }
  }
  return result;
}

/**
 * Builds an `error` {@link ModelEvent}.
 *
 * @param code - Error category.
 * @param message - Message to report; built from {@link ERROR_MESSAGES}, never from foreign text.
 * @param retryable - Whether the agent runtime may retry the step.
 * @returns The event to yield.
 */
function errorEvent(code: ModelErrorCode, message: string, retryable: boolean): ModelErrorEvent {
  return { type: 'error', code, message: redactSecretShapes(message), retryable };
}

/**
 * Maps a `response.failed` error code to a {@link ModelErrorCode}.
 *
 * @param code - Code from `response.error`; absent when the API sent no error object.
 * @returns The category and whether the runtime may retry.
 */
function mapResponseErrorCode(code: ResponseError['code'] | undefined): {
  code: ModelErrorCode;
  retryable: boolean;
} {
  if (code === 'rate_limit_exceeded') {
    return { code: 'rate_limit', retryable: true };
  }
  if (code === 'server_error') {
    return { code: 'unknown', retryable: true };
  }
  return { code: 'unknown', retryable: false };
}

/**
 * Recognises the context-length overflow the API reports as a 400.
 *
 * @param err - The caught SDK error.
 * @returns `true` when the request exceeded the model's context window.
 */
function isContextLengthFailure(err: SdkApiErrorShape): boolean {
  return err.code === 'context_length_exceeded' || CONTEXT_LENGTH_MESSAGE.test(err.message);
}

/**
 * Classifies a thrown SDK error by HTTP status.
 *
 * A missing status means the request never got a response (connection reset, DNS failure,
 * timeout), which the runtime retries.
 *
 * The error's own message is read to classify it and is never copied into the result: the status
 * and the category are the report. The numeric status is appended because it is the provider's,
 * not the server's — a number this function narrowed itself.
 *
 * @param err - The caught SDK error.
 * @returns The `error` event to yield.
 */
function fromSdkApiError(err: SdkApiErrorShape): ModelErrorEvent {
  if (typeof err.status !== 'number') {
    return errorEvent('network', ERROR_MESSAGES.network, true);
  }
  const status = ` (HTTP ${String(err.status)})`;
  if (err.status === 401 || err.status === 403) {
    return errorEvent('auth', `${ERROR_MESSAGES.auth}${status}`, false);
  }
  if (err.status === 429) {
    return errorEvent('rate_limit', `${ERROR_MESSAGES.rateLimit}${status}`, true);
  }
  if (err.status === 400 && isContextLengthFailure(err)) {
    return errorEvent('context_length', `${ERROR_MESSAGES.contextLength}${status}`, false);
  }
  if (err.status >= 500) {
    return errorEvent('unknown', `${ERROR_MESSAGES.providerFailed}${status}`, true);
  }
  return errorEvent('unknown', `${ERROR_MESSAGES.rejected}${status}`, false);
}

/**
 * Refuses to compile when a {@link ConversationItem} member is added without a mapping.
 *
 * The item is deliberately absent from the message: it carries the conversation, which holds
 * whatever the operator typed and whatever a tool printed, and this error would travel to the logs.
 *
 * @param _value - The unmapped member, reachable only through an unchecked cast.
 * @throws Error stating that the item kind has no mapping.
 */
function assertNever(_value: never): never {
  throw new Error('Unsupported conversation item');
}

/**
 * Converts a {@link ToolDefinition} into a Responses API function tool.
 *
 * `strict: true` makes the API validate generated arguments against the JSON Schema, so the agent
 * runtime never has to defend against arguments that do not match the declared shape.
 *
 * @param tool - Tool exposed to the model.
 * @returns The SDK tool definition.
 */
export function toResponseTool(tool: ToolDefinition): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

/**
 * Converts one {@link ConversationItem} into a Responses API input item.
 *
 * @param item - Message, tool call or tool result from the conversation.
 * @returns The SDK input item.
 */
export function toResponseInputItem(item: ConversationItem): ResponseInputItem {
  if (!('type' in item)) {
    return { role: item.role, content: item.content };
  }
  switch (item.type) {
    case 'tool_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    case 'tool_result':
      return { type: 'function_call_output', call_id: item.callId, output: item.output };
    default:
      return assertNever(item);
  }
}

/**
 * Builds the streaming request for one model round-trip.
 *
 * `store: false` is always sent and `previous_response_id` is never used: a continuation handle
 * requires the previous response to have been stored provider-side, which would contradict a
 * design where Postgres owns all conversation state. Every call therefore carries the full
 * `items` list. The model id comes from the input only — configuration is the caller's business.
 *
 * @param input - The turn to send.
 * @returns Parameters for `client.responses.stream`.
 */
export function toResponseParams(input: ModelTurnInput): ResponseCreateParamsStreaming {
  return {
    model: input.model,
    instructions: input.instructions,
    input: input.items.map(toResponseInputItem),
    tools: input.tools.map(toResponseTool),
    store: false,
    stream: true,
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: input.reasoningEffort } }),
  };
}

/**
 * Normalises the usage block of a finished response.
 *
 * @param usage - Usage reported by the API; absent on responses that never started generating.
 * @returns Token counts, zeroed when the API reported none.
 */
export function usageFromResponse(usage: ResponseUsage | null | undefined): ModelUsage {
  if (usage === null || usage === undefined) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

/** Stateful translator from SDK stream events to {@link ModelEvent}s. */
export interface EventMapper {
  /**
   * Translates one SDK event.
   *
   * @param event - Raw event from the Responses stream.
   * @returns Zero or more model events, in order.
   */
  map(event: ResponseStreamEvent): ModelEvent[];
  /** Whether a terminal event (`response.done` or `error`) has already been produced. */
  readonly sawTerminal: boolean;
}

/**
 * Maps the text-bearing events.
 *
 * Refusals are reported as ordinary assistant text so the transcript shows what the model said
 * instead of an empty turn.
 *
 * @param event - Raw event from the Responses stream.
 * @returns The model events, or `undefined` when this mapper does not handle the event.
 */
function mapTextEvent(event: ResponseStreamEvent): ModelEvent[] | undefined {
  if (event.type === 'response.output_text.delta') {
    return [{ type: 'text.delta', text: event.delta }];
  }
  if (event.type === 'response.output_text.done') {
    return [{ type: 'text.done', text: event.text }];
  }
  if (event.type === 'response.refusal.delta') {
    return [{ type: 'text.delta', text: event.delta }];
  }
  if (event.type === 'response.refusal.done') {
    return [{ type: 'text.done', text: event.refusal }];
  }
  return undefined;
}

/**
 * Maps the function-call events, correlating argument deltas with their `call_id`.
 *
 * Argument deltas identify their item by `item_id` while the rest of the system keys tool calls by
 * `call_id`; the correlation is learned from `response.output_item.added`. A delta that arrives
 * before its item falls back to the raw `item_id`, which still keeps the deltas of interleaved
 * calls apart.
 *
 * @param event - Raw event from the Responses stream.
 * @param itemIdToCallId - Correlation learned so far, extended as items are announced.
 * @returns The model events, or `undefined` when this mapper does not handle the event.
 */
function mapToolCallEvent(
  event: ResponseStreamEvent,
  itemIdToCallId: Map<string, string>,
): ModelEvent[] | undefined {
  if (event.type === 'response.output_item.added') {
    if (event.item.type === 'function_call') {
      itemIdToCallId.set(event.item.id ?? event.item.call_id, event.item.call_id);
    }
    return [];
  }
  if (event.type === 'response.function_call_arguments.delta') {
    const callId = itemIdToCallId.get(event.item_id) ?? event.item_id;
    return [{ type: 'tool_call.arguments.delta', callId, delta: event.delta }];
  }
  if (event.type === 'response.output_item.done') {
    if (event.item.type !== 'function_call') {
      return [];
    }
    const { call_id: callId, name, arguments: args } = event.item;
    return [{ type: 'tool_call', callId, name, arguments: args }];
  }
  return undefined;
}

/**
 * Maps the events that end a round-trip.
 *
 * `response.incomplete` is reported as a normal completion: the step produced output and stopped
 * for a declared reason (typically the output-token cap), which the caller handles by continuing
 * the loop rather than by failing the turn.
 *
 * @param event - Raw event from the Responses stream.
 * @returns The model events, or `undefined` when this mapper does not handle the event.
 */
function mapTerminalEvent(event: ResponseStreamEvent): ModelEvent[] | undefined {
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    return [
      {
        type: 'response.done',
        responseId: event.response.id,
        usage: usageFromResponse(event.response.usage),
      },
    ];
  }
  if (event.type === 'response.failed') {
    // `error.code` is a closed union used to classify; `error.message` is free-form server text
    // and is deliberately not reported.
    const { code, retryable } = mapResponseErrorCode(event.response.error?.code);
    return [errorEvent(code, ERROR_MESSAGES.responseFailed, retryable)];
  }
  if (event.type === 'error') {
    return [errorEvent('unknown', ERROR_MESSAGES.streamError, false)];
  }
  return undefined;
}

/**
 * Creates the per-stream event mapper.
 *
 * One instance handles exactly one `client.responses.stream` call: it keeps the `item_id` →
 * `call_id` correlation of that stream and remembers whether a terminal event was produced.
 *
 * @returns A fresh mapper.
 */
export function createEventMapper(): EventMapper {
  const itemIdToCallId = new Map<string, string>();
  let sawTerminal = false;
  return {
    get sawTerminal(): boolean {
      return sawTerminal;
    },
    map(event: ResponseStreamEvent): ModelEvent[] {
      const text = mapTextEvent(event);
      if (text !== undefined) {
        return text;
      }
      const toolCall = mapToolCallEvent(event, itemIdToCallId);
      if (toolCall !== undefined) {
        return toolCall;
      }
      const terminal = mapTerminalEvent(event);
      if (terminal === undefined) {
        return [];
      }
      sawTerminal = true;
      return terminal;
    },
  };
}

/**
 * Classifies an error thrown by the SDK into an `error` {@link ModelEvent}.
 *
 * Checked in order: cancellation (reported as `null` so the caller can end the stream silently),
 * the `APIError` hierarchy by HTTP status, a bare `fetch` failure, and everything else.
 *
 * **No foreign text reaches the event.** The caught error's message is read to classify the
 * failure and is never copied into the result; every message comes from {@link ERROR_MESSAGES}
 * plus, where one exists, the numeric HTTP status. Three separate channels made forwarding it
 * unsafe, and none of them is covered by matching credential shapes:
 *
 * - `APIError.message` is built from the response body (`makeMessage`), which on an authentication
 *   failure echoes part of the submitted key.
 * - The SDK raises an `APIError` whose body is whatever JSON the endpoint sent
 *   (`core/streaming.js`), and `makeMessage` serialises that object into the message.
 * - A malformed stream line makes the SDK rethrow the platform `SyntaxError`, whose message quotes
 *   a prefix of the raw bytes (`Unexpected token 'g', "gateway-se"... is not valid JSON`).
 *
 * The credential is whatever the operator typed and the endpoint is whatever `OPENAI_BASE_URL`
 * points at, so no pattern list can recognise it. The event still carries the category and
 * `retryable`, which is what the agent runtime and the UI branch on.
 *
 * @param err - Anything caught around an SDK call.
 * @returns The event to yield, or `null` when the stream was cancelled.
 */
export function mapErrorToModelEvent(err: unknown): ModelErrorEvent | null {
  if (isAbortError(err)) {
    return null;
  }
  if (isSdkApiError(err)) {
    return fromSdkApiError(err);
  }
  if (err instanceof TypeError && FETCH_FAILED_MESSAGE.test(err.message)) {
    return errorEvent('network', ERROR_MESSAGES.network, true);
  }
  return errorEvent('unknown', ERROR_MESSAGES.unknown, false);
}
