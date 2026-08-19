/**
 * Choosing the model provider the turn runs against.
 *
 * Layer: adapter.
 *
 * The bundle carries the fake provider and a seam for the real one. The OpenAI client is not
 * imported here: a factory is injected by whoever composes the runtime, which keeps the OpenAI SDK
 * — and its transitive dependencies — out of the bundle until something actually wires it in, and
 * keeps this module free of any code that reads an API key.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentModelProvider } from '@agent-hangar/core';
import { FakeAgentModelProvider } from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';

import { builtInFakeScript } from './fake-scripts.js';

/** Provider used when the environment names none. */
export const DEFAULT_PROVIDER_NAME = 'openai';

/** Options a provider factory receives. */
export interface ProviderFactoryOptions {
  /** API key read from the container environment. */
  apiKey: string;
  /** Alternative endpoint, when the environment names one. */
  baseURL?: string;
}

/** Factories for the providers this build cannot construct on its own. */
export interface ProviderFactories {
  /** Builds the OpenAI provider from the API key and the optional endpoint. */
  openai?: (options: ProviderFactoryOptions) => AgentModelProvider;
}

/**
 * Reads which provider the turn should use.
 *
 * @param env - Container environment.
 * @returns The provider name.
 */
export function resolveProviderName(env: Readonly<Record<string, string | undefined>>): string {
  return env.AGENT_MODEL_PROVIDER ?? DEFAULT_PROVIDER_NAME;
}

/**
 * Builds the scripted provider, from the environment's script when it supplies one.
 *
 * @param env - Container environment.
 * @returns The fake provider.
 * @throws ConfigError when `AGENT_FAKE_SCRIPT_JSON` is not valid JSON.
 */
function createFakeProvider(env: Readonly<Record<string, string | undefined>>): AgentModelProvider {
  const override = env.AGENT_FAKE_SCRIPT_JSON;
  if (override === undefined) {
    return new FakeAgentModelProvider({ script: builtInFakeScript() });
  }
  try {
    return new FakeAgentModelProvider({ script: JSON.parse(override) as ProviderScript });
  } catch {
    // The parse error quotes a prefix of its input, which came from the container environment.
    throw new ConfigError('AGENT_FAKE_SCRIPT_JSON is not valid JSON');
  }
}

/**
 * Builds the OpenAI provider through the injected factory.
 *
 * @param env - Container environment.
 * @param factories - Factories supplied by whoever composed the runtime.
 * @returns The provider.
 * @throws ConfigError when no factory was wired in or no API key was injected.
 */
function createOpenAiProvider(
  env: Readonly<Record<string, string | undefined>>,
  factories: ProviderFactories,
): AgentModelProvider {
  const { openai } = factories;
  if (openai === undefined) {
    throw new ConfigError(
      'the openai provider is not wired into this build; see packages/agent-runtime/src/provider.ts',
    );
  }
  const configured = env.OPENAI_API_KEY ?? '';
  if (configured.length === 0) {
    throw new ConfigError('OPENAI_API_KEY is not set in the workspace environment');
  }
  const baseURL = env.OPENAI_BASE_URL;
  return openai(baseURL === undefined ? { apiKey: configured } : { apiKey: configured, baseURL });
}

/**
 * Builds the provider the turn will stream from.
 *
 * @param name - Provider name, from {@link resolveProviderName}.
 * @param env - Container environment.
 * @param factories - Factories for the providers this build cannot construct on its own.
 * @returns The provider.
 * @throws ConfigError when the name is unknown or the provider cannot be configured.
 */
export function createProvider(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  factories: ProviderFactories = {},
): AgentModelProvider {
  if (name === 'fake') {
    return createFakeProvider(env);
  }
  if (name === DEFAULT_PROVIDER_NAME) {
    return createOpenAiProvider(env, factories);
  }
  // The name is not echoed: this message becomes a persisted, displayed `turn.failed`, and the
  // operator can read their own environment. Naming the valid values is what helps them.
  throw new ConfigError('AGENT_MODEL_PROVIDER must be "openai" or "fake"');
}
