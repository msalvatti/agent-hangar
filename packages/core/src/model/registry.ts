/**
 * Maps a provider name to an {@link AgentModelProvider} instance.
 *
 * Layer: service (composition).
 *
 * The single place that knows which implementations exist, so the worker and the end-to-end suite
 * select one by configuration (`AGENT_MODEL_PROVIDER`) instead of importing a provider class.
 */
import { MODEL_PROVIDERS } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { FakeAgentModelProvider } from '../testing/fake-agent-model-provider.ts';
import type { FakeAgentModelProviderOptions } from '../testing/fake-agent-model-provider.ts';

import { createOpenAIClient } from './openai/client.ts';
import type { OpenAIResponsesClient } from './openai/client.ts';
import { createOpenAIModelProvider } from './openai/provider.ts';
import type { AgentModelProvider } from './types.ts';

/** Provider names the registry can build — the same list the environment schema validates. */
export const MODEL_PROVIDER_NAMES = MODEL_PROVIDERS;

/** One provider name. */
export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

/** Reported when `openai` is selected but nothing supplies a credential. */
const MISSING_KEY_MESSAGE = 'OpenAI API key is not configured — add it in Settings.';

/** Script a fake provider plays when the caller supplies none. */
const EMPTY_SCRIPT: FakeAgentModelProviderOptions = { script: {} };

/**
 * Narrows an arbitrary value to a known provider name.
 *
 * @param value - Configured value, typically straight from the environment.
 * @returns `true` when the registry can build a provider for it.
 */
export function isModelProviderName(value: unknown): value is ModelProviderName {
  // Stryker disable next-line ConditionalExpression: a value that is not text is in no list of
  // names, so the search below refuses it either way. Asked first because the question is what the
  // value is, and the search is how the answer is confirmed.
  return typeof value === 'string' && (MODEL_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** What each provider needs in order to be built. */
export interface CreateModelProviderDeps {
  /** Credential or a ready client for the OpenAI provider. */
  openai?: {
    /** API key, revealed per turn by the worker. */
    apiKey?: string;
    /** Alternative endpoint, for a compatible gateway. */
    baseURL?: string;
    /** Ready client, which takes precedence and skips SDK construction entirely. */
    client?: OpenAIResponsesClient;
  };
  /** Script and model ids for the fake provider. */
  fake?: FakeAgentModelProviderOptions;
}

/**
 * Resolves the client the OpenAI provider will stream through.
 *
 * @param openai - The OpenAI section of the dependencies.
 * @returns The client to use.
 * @throws ConfigError when neither a client nor a key was supplied.
 */
function resolveOpenAIClient(openai: CreateModelProviderDeps['openai']): OpenAIResponsesClient {
  if (openai?.client !== undefined) {
    return openai.client;
  }
  if (openai?.apiKey === undefined || openai.apiKey.length === 0) {
    throw new ConfigError(MISSING_KEY_MESSAGE);
  }
  return createOpenAIClient({
    apiKey: openai.apiKey,
    // Stryker disable next-line ConditionalExpression: spread conditionally because the property is
    // optional and this project forbids handing one an explicit `undefined`; the client reads an
    // absent base URL and one set to nothing as the same instruction.
    ...(openai.baseURL === undefined ? {} : { baseURL: openai.baseURL }),
  });
}

/**
 * Builds the provider selected by name.
 *
 * The worker calls this once per turn, right after `reveal('OPENAI_API_KEY')`, and hands the key
 * straight in — it is never logged and never stored on the provider beyond the SDK client. The
 * model id is not part of the registry: it travels in `ModelTurnInput.model`, so one provider
 * instance serves any model the credential can reach.
 *
 * The invalid name is deliberately absent from the error: configuration errors elsewhere report
 * the variable and the expectation, never the value that was read.
 *
 * @param name - Configured provider name, typically `AGENT_MODEL_PROVIDER`.
 * @param deps - What the selected provider needs.
 * @returns The provider instance.
 * @throws ConfigError when the name is unknown or the OpenAI credential is missing.
 */
export function createModelProvider(
  name: string,
  deps: CreateModelProviderDeps = {},
): AgentModelProvider {
  if (!isModelProviderName(name)) {
    throw new ConfigError(
      `Unknown AGENT_MODEL_PROVIDER (expected one of: ${MODEL_PROVIDER_NAMES.join(', ')}).`,
    );
  }
  if (name === 'fake') {
    return new FakeAgentModelProvider(deps.fake ?? EMPTY_SCRIPT);
  }
  return createOpenAIModelProvider({ client: resolveOpenAIClient(deps.openai) });
}
