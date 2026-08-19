/**
 * Unit tests of the OpenAI Responses mapping layer.
 *
 * Layer: test.
 *
 * The SDK error classes are imported from their own module (`openai/core/error`) rather than the
 * package root so the production rule "only `client.ts` imports `openai` at runtime" stays greppable,
 * while the classifier is still exercised against the real classes it has to recognise.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai/core/error';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';

import { OPENAI_CANARY } from '../../testing/canaries.js';
import type { ConversationItem, ModelTurnInput } from '../types.js';

import {
  LIFECYCLE_EVENT_TYPES,
  VERIFIED_EVENT_TYPES,
  createEventMapper,
  mapErrorToModelEvent,
  toResponseInputItem,
  toResponseParams,
  toResponseTool,
  usageFromResponse,
} from './mapping.js';

/** Usage block shaped exactly as the API sends it. */
const USAGE: ResponseUsage = {
  input_tokens: 120,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
  output_tokens: 18,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 138,
};

/**
 * Builds a `Response` snapshot with every field the SDK declares as required.
 *
 * @param overrides - Fields that matter for the assertion under test.
 * @returns A complete response object.
 */
function makeResponse(overrides: Partial<Response> = {}): Response {
  return {
    id: 'resp_0a1b2c3d4e5f60718293a4b5',
    created_at: 1_766_000_000,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5.6-sol',
    object: 'response',
    output: [],
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    ...overrides,
  };
}

/**
 * Builds a function-call output item.
 *
 * @param overrides - Fields that matter for the assertion under test.
 * @returns The item as the API sends it.
 */
function makeFunctionCall(
  overrides: Partial<ResponseFunctionToolCall> = {},
): ResponseFunctionToolCall {
  return {
    type: 'function_call',
    id: 'fc_11112222333344445555',
    call_id: 'call_aaaabbbbccccdddd',
    name: 'run_shell',
    arguments: '{"command":"ls -la"}',
    status: 'completed',
    ...overrides,
  };
}

/** Message output item used where the mapper must ignore a non-function item. */
const MESSAGE_ITEM: ResponseOutputMessage = {
  id: 'msg_9988776655443322',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [],
};

/**
 * Builds an SDK `APIError` for one status.
 *
 * @param status - HTTP status the API returned.
 * @param message - Message carried by the response body.
 * @param code - Machine-readable code carried by the response body.
 * @returns The error instance the SDK would throw; the SDK prefixes its message with the status.
 */
function apiError(status: number, message: string, code?: string): APIError {
  const body = code === undefined ? { message } : { message, code };
  return new APIError(status, body, message, new Headers());
}

/** Minimal turn input; individual tests override what they assert on. */
const BASE_INPUT: ModelTurnInput = {
  model: 'gpt-5.6-sol',
  instructions: 'You are a coding agent.',
  items: [{ role: 'user', content: 'hello' }],
  tools: [],
};

describe('VERIFIED_EVENT_TYPES', () => {
  it('lists the consumed and ignored event names as disjoint sets', () => {
    // A name in both lists would mean an event is claimed to be mapped and ignored at once.
    const overlap = VERIFIED_EVENT_TYPES.filter((type) =>
      (LIFECYCLE_EVENT_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
    expect(VERIFIED_EVENT_TYPES).toContain('response.function_call_arguments.delta');
    expect(LIFECYCLE_EVENT_TYPES).toContain('response.created');
  });
});

describe('toResponseTool', () => {
  it('requests strict schema validation for every tool', () => {
    // strict mode is what lets the runtime trust the shape of generated arguments.
    const tool = toResponseTool({
      name: 'run_shell',
      description: 'Runs a shell command.',
      parameters: { type: 'object', properties: {} },
    });
    expect(tool).toEqual({
      type: 'function',
      name: 'run_shell',
      description: 'Runs a shell command.',
      parameters: { type: 'object', properties: {} },
      strict: true,
    });
  });
});

describe('toResponseInputItem', () => {
  it('maps a conversation message to an input message', () => {
    // Roles travel unchanged; `system` is a valid Responses role and is not rewritten.
    expect(toResponseInputItem({ role: 'system', content: 'be brief' })).toEqual({
      role: 'system',
      content: 'be brief',
    });
  });

  it('maps a tool call to a function_call item', () => {
    // The model needs its own previous call echoed back to continue the loop.
    expect(
      toResponseInputItem({
        type: 'tool_call',
        callId: 'call_1',
        name: 'run_shell',
        arguments: '{}',
      }),
    ).toEqual({ type: 'function_call', call_id: 'call_1', name: 'run_shell', arguments: '{}' });
  });

  it('maps a tool result to a function_call_output item', () => {
    // The result is correlated by call_id, never by position.
    expect(toResponseInputItem({ type: 'tool_result', callId: 'call_1', output: 'ok' })).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'ok',
    });
  });

  it('throws without repeating the item when an unmapped kind reaches the mapper', () => {
    // The item carries the conversation, so the guard names the problem and nothing else.
    const impossible: unknown = { type: 'telepathy', content: OPENAI_CANARY };
    const failure = (() => {
      try {
        toResponseInputItem(impossible as ConversationItem);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    })();
    expect(failure).toBe('Unsupported conversation item');
  });
});

describe('toResponseParams', () => {
  it('always disables server-side storage and never sends a continuation handle', () => {
    // Stateless by design: Postgres owns conversation state, so `store` must stay false.
    const params = toResponseParams(BASE_INPUT);
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    expect(Object.keys(params)).not.toContain('previous_response_id');
  });

  it('takes the model id from the input and maps items and tools', () => {
    // Configuration never reaches this layer; the caller resolves the model id.
    const params = toResponseParams({
      ...BASE_INPUT,
      model: 'gpt-5.6-mini',
      items: [
        { role: 'user', content: 'hi' },
        { type: 'tool_call', callId: 'call_1', name: 'run_shell', arguments: '{}' },
        { type: 'tool_result', callId: 'call_1', output: 'done' },
      ],
      tools: [{ name: 't', description: 'd', parameters: {} }],
    });
    expect(params.model).toBe('gpt-5.6-mini');
    expect(params.input).toHaveLength(3);
    expect(params.tools?.[0]).toMatchObject({ type: 'function', strict: true });
  });

  it('omits the reasoning key when no effort is requested', () => {
    // `exactOptionalPropertyTypes` forbids an explicit undefined, and the API rejects it too.
    expect(Object.keys(toResponseParams(BASE_INPUT))).not.toContain('reasoning');
  });

  it('includes the reasoning effort when requested', () => {
    // Reasoning-capable models take the effort hint straight from the turn input.
    const params = toResponseParams({ ...BASE_INPUT, reasoningEffort: 'high' });
    expect(params.reasoning).toEqual({ effort: 'high' });
  });
});

describe('usageFromResponse', () => {
  it('reports zero tokens when the API sent no usage block', () => {
    // A response that failed before generating carries no usage; the turn still needs numbers.
    expect(usageFromResponse(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(usageFromResponse(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('renames the snake_case token counts', () => {
    // The rest of the system speaks camelCase; this is the only place the API spelling appears.
    expect(usageFromResponse(USAGE)).toEqual({ inputTokens: 120, outputTokens: 18 });
  });
});

describe('createEventMapper', () => {
  it('maps text deltas and the finalised text', () => {
    // The two events drive the live transcript and the stored assistant message respectively.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.output_text.delta',
        delta: 'Hello',
        content_index: 0,
        item_id: 'msg_1',
        logprobs: [],
        output_index: 0,
        sequence_number: 1,
      }),
    ).toEqual([{ type: 'text.delta', text: 'Hello' }]);
    expect(
      mapper.map({
        type: 'response.output_text.done',
        text: 'Hello, world.',
        content_index: 0,
        item_id: 'msg_1',
        logprobs: [],
        output_index: 0,
        sequence_number: 2,
      }),
    ).toEqual([{ type: 'text.done', text: 'Hello, world.' }]);
  });

  it('reports refusals as assistant text', () => {
    // A refusal is something the user must read, so it takes the same path as normal text.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.refusal.delta',
        delta: 'I cannot',
        content_index: 0,
        item_id: 'msg_1',
        output_index: 0,
        sequence_number: 1,
      }),
    ).toEqual([{ type: 'text.delta', text: 'I cannot' }]);
    expect(
      mapper.map({
        type: 'response.refusal.done',
        refusal: 'I cannot help with that.',
        content_index: 0,
        item_id: 'msg_1',
        output_index: 0,
        sequence_number: 2,
      }),
    ).toEqual([{ type: 'text.done', text: 'I cannot help with that.' }]);
  });

  it('resolves argument deltas of interleaved calls to the right call ids', () => {
    // Two parallel tool calls share the stream; only item_id tells their deltas apart.
    const mapper = createEventMapper();
    mapper.map({
      type: 'response.output_item.added',
      item: makeFunctionCall({ id: 'fc_a', call_id: 'call_a' }),
      output_index: 0,
      sequence_number: 1,
    });
    mapper.map({
      type: 'response.output_item.added',
      item: makeFunctionCall({ id: 'fc_b', call_id: 'call_b' }),
      output_index: 1,
      sequence_number: 2,
    });
    const first = mapper.map({
      type: 'response.function_call_arguments.delta',
      delta: '{"a"',
      item_id: 'fc_a',
      output_index: 0,
      sequence_number: 3,
    });
    const second = mapper.map({
      type: 'response.function_call_arguments.delta',
      delta: '{"b"',
      item_id: 'fc_b',
      output_index: 1,
      sequence_number: 4,
    });
    expect(first).toEqual([{ type: 'tool_call.arguments.delta', callId: 'call_a', delta: '{"a"' }]);
    expect(second).toEqual([
      { type: 'tool_call.arguments.delta', callId: 'call_b', delta: '{"b"' },
    ]);
  });

  it('correlates by call_id when the item carries no id', () => {
    // `ResponseFunctionToolCall.id` is optional in the shipped types.
    const mapper = createEventMapper();
    const item = makeFunctionCall({ call_id: 'call_only' });
    delete item.id;
    mapper.map({
      type: 'response.output_item.added',
      item,
      output_index: 0,
      sequence_number: 1,
    });
    expect(
      mapper.map({
        type: 'response.function_call_arguments.delta',
        delta: '{}',
        item_id: 'call_only',
        output_index: 0,
        sequence_number: 2,
      }),
    ).toEqual([{ type: 'tool_call.arguments.delta', callId: 'call_only', delta: '{}' }]);
  });

  it('falls back to the raw item id for a delta that arrives before its item', () => {
    // Keeps deltas of different calls apart even when the correlation is not known yet.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.function_call_arguments.delta',
        delta: '{',
        item_id: 'fc_unknown',
        output_index: 0,
        sequence_number: 1,
      }),
    ).toEqual([{ type: 'tool_call.arguments.delta', callId: 'fc_unknown', delta: '{' }]);
  });

  it('ignores added and finished items that are not function calls', () => {
    // Message items are already covered by the text events; emitting them again would duplicate.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.output_item.added',
        item: MESSAGE_ITEM,
        output_index: 0,
        sequence_number: 1,
      }),
    ).toEqual([]);
    expect(
      mapper.map({
        type: 'response.output_item.done',
        item: MESSAGE_ITEM,
        output_index: 0,
        sequence_number: 2,
      }),
    ).toEqual([]);
  });

  it('emits the complete tool call when its item finishes', () => {
    // Downstream only executes a tool once the arguments are known to be complete.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.output_item.done',
        item: makeFunctionCall(),
        output_index: 0,
        sequence_number: 1,
      }),
    ).toEqual([
      {
        type: 'tool_call',
        callId: 'call_aaaabbbbccccdddd',
        name: 'run_shell',
        arguments: '{"command":"ls -la"}',
      },
    ]);
  });

  it('ends the round-trip on response.completed', () => {
    // `sawTerminal` is what lets the provider stop iterating instead of draining the stream.
    const mapper = createEventMapper();
    expect(mapper.sawTerminal).toBe(false);
    expect(
      mapper.map({
        type: 'response.completed',
        response: makeResponse({ usage: USAGE }),
        sequence_number: 9,
      }),
    ).toEqual([
      {
        type: 'response.done',
        responseId: 'resp_0a1b2c3d4e5f60718293a4b5',
        usage: { inputTokens: 120, outputTokens: 18 },
      },
    ]);
    expect(mapper.sawTerminal).toBe(true);
  });

  it('ends the round-trip on response.incomplete', () => {
    // Hitting the output-token cap ends the step; the loop continues, the turn does not fail.
    const mapper = createEventMapper();
    const events = mapper.map({
      type: 'response.incomplete',
      response: makeResponse({
        usage: USAGE,
        incomplete_details: { reason: 'max_output_tokens' },
      }),
      sequence_number: 9,
    });
    expect(events).toEqual([
      {
        type: 'response.done',
        responseId: 'resp_0a1b2c3d4e5f60718293a4b5',
        usage: { inputTokens: 120, outputTokens: 18 },
      },
    ]);
    expect(mapper.sawTerminal).toBe(true);
  });

  it('maps a rate-limited response.failed to a retryable error', () => {
    // The runtime backs off and retries only when the provider says the failure is transient.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.failed',
        response: makeResponse({
          error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for requests' },
        }),
        sequence_number: 3,
      }),
    ).toEqual([
      {
        type: 'error',
        code: 'rate_limit',
        message: 'Rate limit reached for requests',
        retryable: true,
      },
    ]);
    expect(mapper.sawTerminal).toBe(true);
  });

  it('treats a server-side response.failed as retryable and a prompt failure as final', () => {
    // Only the server-error class is worth retrying; an invalid prompt would fail again.
    const server = createEventMapper().map({
      type: 'response.failed',
      response: makeResponse({ error: { code: 'server_error', message: 'boom' } }),
      sequence_number: 3,
    });
    const prompt = createEventMapper().map({
      type: 'response.failed',
      response: makeResponse({ error: { code: 'invalid_prompt', message: 'bad prompt' } }),
      sequence_number: 3,
    });
    expect(server).toEqual([{ type: 'error', code: 'unknown', message: 'boom', retryable: true }]);
    expect(prompt).toEqual([
      { type: 'error', code: 'unknown', message: 'bad prompt', retryable: false },
    ]);
  });

  it('describes a response.failed that carries no error object', () => {
    // The event type is declared with an optional error; the message must never be empty.
    expect(
      createEventMapper().map({
        type: 'response.failed',
        response: makeResponse(),
        sequence_number: 3,
      }),
    ).toEqual([{ type: 'error', code: 'unknown', message: 'response failed', retryable: false }]);
  });

  it('maps a stream-level error event, falling back when it has no message', () => {
    // A transport-level error ends the stream; it is never retried blindly.
    expect(
      createEventMapper().map({
        type: 'error',
        code: 'server_error',
        message: 'The server had an error',
        param: null,
        sequence_number: 1,
      }),
    ).toEqual([
      {
        type: 'error',
        code: 'unknown',
        message: 'The server had an error',
        retryable: false,
      },
    ]);
    expect(
      createEventMapper().map({
        type: 'error',
        code: null,
        message: '',
        param: null,
        sequence_number: 1,
      }),
    ).toEqual([{ type: 'error', code: 'unknown', message: 'stream error', retryable: false }]);
  });

  it('ignores every event it does not consume', () => {
    // Lifecycle and future events must not break a stream or leak into the transcript.
    const mapper = createEventMapper();
    expect(
      mapper.map({
        type: 'response.created',
        response: makeResponse(),
        sequence_number: 0,
      }),
    ).toEqual([]);
    const future: unknown = { type: 'response.something.new' };
    expect(mapper.map(future as ResponseStreamEvent)).toEqual([]);
    expect(mapper.sawTerminal).toBe(false);
  });
});

describe('mapErrorToModelEvent', () => {
  it('reports a cancellation as no event at all', () => {
    // Aborting is a user action, not a failure; the stream just ends.
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    expect(mapErrorToModelEvent(aborted)).toBeNull();
  });

  it('maps 401 and 403 to a non-retryable auth error', () => {
    // The UI links these to Settings; retrying with the same key cannot help.
    expect(mapErrorToModelEvent(apiError(401, 'Incorrect API key provided'))).toEqual({
      type: 'error',
      code: 'auth',
      message: '401 Incorrect API key provided',
      retryable: false,
    });
    expect(mapErrorToModelEvent(apiError(403, 'Forbidden'))?.code).toBe('auth');
  });

  it('maps 429 to a retryable rate-limit error', () => {
    // The agent runtime owns the backoff; the SDK is configured not to retry.
    expect(mapErrorToModelEvent(apiError(429, 'Rate limit reached'))).toEqual({
      type: 'error',
      code: 'rate_limit',
      message: '429 Rate limit reached',
      retryable: true,
    });
  });

  it('maps a 400 context overflow by code and by message', () => {
    // Older deployments send only prose, so both signals have to be recognised.
    expect(mapErrorToModelEvent(apiError(400, 'too long', 'context_length_exceeded'))?.code).toBe(
      'context_length',
    );
    expect(
      mapErrorToModelEvent(apiError(400, 'This model supports a maximum context of 400k tokens'))
        ?.code,
    ).toBe('context_length');
  });

  it('maps any other 4xx to a non-retryable unknown error', () => {
    // A malformed request or a missing model will fail identically on a retry.
    expect(mapErrorToModelEvent(apiError(400, 'Invalid tool schema'))).toEqual({
      type: 'error',
      code: 'unknown',
      message: '400 Invalid tool schema',
      retryable: false,
    });
    expect(mapErrorToModelEvent(apiError(404, 'No such model'))?.retryable).toBe(false);
  });

  it('maps 5xx to a retryable unknown error', () => {
    // Server-side faults are transient often enough to be worth one more attempt.
    expect(mapErrorToModelEvent(apiError(503, 'Service unavailable'))).toEqual({
      type: 'error',
      code: 'unknown',
      message: '503 Service unavailable',
      retryable: true,
    });
  });

  it('maps the SDK connection errors to a retryable network error', () => {
    // These carry no status because the request never reached the API.
    expect(mapErrorToModelEvent(new APIConnectionError({ message: 'Connection error.' }))).toEqual({
      type: 'error',
      code: 'network',
      message: 'Connection error.',
      retryable: true,
    });
    expect(mapErrorToModelEvent(new APIConnectionTimeoutError())?.code).toBe('network');
    expect(mapErrorToModelEvent(new APIUserAbortError())?.code).toBe('network');
  });

  it('maps a bare fetch failure to a retryable network error', () => {
    // Node raises this TypeError before the SDK can wrap it.
    expect(mapErrorToModelEvent(new TypeError('fetch failed'))).toEqual({
      type: 'error',
      code: 'network',
      message: 'fetch failed',
      retryable: true,
    });
  });

  it('maps any other error to a non-retryable unknown error', () => {
    // Includes a TypeError that is not a transport failure, and an empty message.
    expect(mapErrorToModelEvent(new TypeError('x is not a function'))).toEqual({
      type: 'error',
      code: 'unknown',
      message: 'x is not a function',
      retryable: false,
    });
    expect(mapErrorToModelEvent(new Error(''))?.message).toBe('unknown error');
  });

  it('maps a thrown non-error value without describing it', () => {
    // A thrown string could carry anything, so nothing of it is repeated.
    expect(mapErrorToModelEvent('boom')).toEqual({
      type: 'error',
      code: 'unknown',
      message: 'unknown error',
      retryable: false,
    });
  });

  it('never lets a credential-shaped string reach the error message', () => {
    // The API echoes part of the submitted key on some auth failures.
    const event = mapErrorToModelEvent(
      apiError(401, `Incorrect API key provided: ${OPENAI_CANARY}. Also ${OPENAI_CANARY}.`),
    );
    expect(event?.message).toBe('401 Incorrect API key provided: [REDACTED]. Also [REDACTED].');
    expect(event?.message).not.toContain(OPENAI_CANARY);
  });
});
