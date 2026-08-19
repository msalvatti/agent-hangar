/**
 * `AgentModelProvider` contract: the LLM boundary.
 *
 * Layer: service (port).
 *
 * One implementation ships (`OpenAIModelProvider` over the Responses API, under `model/openai/`).
 * Adding a provider means implementing this interface and registering it under a name.
 */

/** A function tool exposed to the model. */
export interface ToolDefinition {
  /** Tool name as the model will call it. */
  name: string;
  /** What the tool does, shown to the model. */
  description: string;
  /** JSON Schema (draft 2020-12); strict mode requested from the provider. */
  parameters: Record<string, unknown>;
}

/** One item of the conversation sent to the model. */
export type ConversationItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; output: string };

/** Reasoning effort hint forwarded to reasoning-capable models. */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** Input of one model round-trip. */
export interface ModelTurnInput {
  /** Model id (from configuration, never from the model itself). */
  model: string;
  /** System prompt. */
  instructions: string;
  /** Full conversation so far (history window + this turn's tool calls/results). */
  items: readonly ConversationItem[];
  /** Tools the model may call. */
  tools: readonly ToolDefinition[];
  /**
   * No provider-side continuation handle on purpose: every call carries the full `items` list,
   * so the provider stays stateless and `store: false` is always valid.
   */
  reasoningEffort?: ReasoningEffort;
  /** Aborting ends the stream without an `error` event. */
  signal?: AbortSignal;
}

/** Token usage reported by the provider at the end of a response. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Error categories a provider maps its failures to. */
export type ModelErrorCode = 'rate_limit' | 'auth' | 'context_length' | 'network' | 'unknown';

/** Events yielded by {@link AgentModelProvider.stream}. */
export type ModelEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'text.done'; text: string }
  /** Emitted once the tool-call arguments are complete. */
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  | { type: 'tool_call.arguments.delta'; callId: string; delta: string }
  | { type: 'response.done'; responseId: string; usage: ModelUsage }
  | { type: 'error'; code: ModelErrorCode; message: string; retryable: boolean };

/** Streams model responses. */
export interface AgentModelProvider {
  /** Provider name, e.g. `"openai"` or `"fake"`. */
  readonly name: string;
  /** One model round-trip. Yields deltas; ends with `response.done` or `error`. */
  stream(input: ModelTurnInput): AsyncIterable<ModelEvent>;
  /** Used by doctor/settings to validate a key and model id. */
  listModels(): Promise<string[]>;
}
