/**
 * Choosing the model provider the turn runs against.
 *
 * Layer: adapter.
 *
 * The bundle carries the fake provider and a seam for the real one. The OpenAI client is not
 * imported here: a factory is injected by whoever composes the runtime — `composition.ts` — so the
 * module that decides which provider a turn runs against holds no code that reads an API key, and
 * a suite can exercise every branch of that decision without the SDK.
 *
 * A supplied script arrives as text, so a scripted step that has to carry the workspace's GitHub
 * credential — the way to prove the credential is redacted on its way to a row — writes a
 * placeholder instead and has it substituted here. That keeps the credential where the runtime
 * already holds it, rather than copying it into a variable that crosses a process boundary to get
 * here.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentModelProvider } from '@agent-hangar/core';
import { FakeAgentModelProvider } from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';

import type { WorkspaceCredentials } from './credentials.js';
import { builtInFakeScript } from './fake-scripts.js';

/** Provider used when the environment names none. */
export const DEFAULT_PROVIDER_NAME = 'openai';

/** Text a scripted response writes where the workspace's GitHub credential belongs. */
export const GITHUB_CREDENTIAL_PLACEHOLDER = '{{GITHUB_CANARY}}';

/** Options a provider factory receives. */
export interface ProviderFactoryOptions {
  /** API key of this turn. */
  apiKey: string;
  /** Alternative endpoint, when the environment names one. */
  baseURL?: string;
}

/**
 * Factories for the providers this module does not construct on its own.
 *
 * Every member is required. A half-filled object was once expressible — and a build that supplied
 * one type-checked, shipped, and only failed on the operator's first real turn — so the type now
 * refuses it: a composition that names this type has to wire every provider in it.
 */
export interface ProviderFactories {
  /** Builds the OpenAI provider from the API key and the optional endpoint. */
  openai: (options: ProviderFactoryOptions) => AgentModelProvider;
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
 * Fills the credential placeholder of a supplied script.
 *
 * The substitution is textual, and a script nests JSON inside JSON — a tool call's arguments are
 * a string of their own — so what goes in has to be a token: a value carrying a quote or a
 * backslash would not survive the encoding it lands in. It fails loudly when it does not, as an
 * unparseable script or unparseable tool arguments, and the credentials this stands for are
 * token-shaped.
 *
 * @param script - Text of the supplied script.
 * @param credential - The workspace's GitHub credential.
 * @returns The text, with every placeholder replaced.
 */
function fillCredentialPlaceholder(script: string, credential: string): string {
  return script.replaceAll(GITHUB_CREDENTIAL_PLACEHOLDER, credential);
}

/**
 * Builds the scripted provider, from the environment's script when it supplies one.
 *
 * @param env - Container environment.
 * @param credentials - The turn's credentials, for a script that asks for the GitHub one.
 * @returns The fake provider.
 * @throws ConfigError when `AGENT_FAKE_SCRIPT_JSON` is not valid JSON.
 */
function createFakeProvider(
  env: Readonly<Record<string, string | undefined>>,
  credentials: WorkspaceCredentials,
): AgentModelProvider {
  const override = env.AGENT_FAKE_SCRIPT_JSON;
  if (override === undefined) {
    return new FakeAgentModelProvider({ script: builtInFakeScript() });
  }
  const filled = fillCredentialPlaceholder(override, credentials.githubToken);
  try {
    return new FakeAgentModelProvider({ script: JSON.parse(filled) as ProviderScript });
  } catch {
    // The parse error quotes a prefix of its input, which came from the container environment.
    throw new ConfigError('AGENT_FAKE_SCRIPT_JSON is not valid JSON');
  }
}

/**
 * Builds the OpenAI provider through the injected factory.
 *
 * The key is never checked for emptiness here: it arrives from the credentials document, whose
 * schema refuses an empty one, so a guard on this side could only ever be a branch no input
 * reaches.
 *
 * @param env - Container environment, for the optional endpoint.
 * @param factories - Factories supplied by whoever composed the runtime, absent in a build that
 *   wired none.
 * @param credentials - The turn's credentials.
 * @returns The provider.
 * @throws ConfigError when no factory was wired in.
 */
function createOpenAiProvider(
  env: Readonly<Record<string, string | undefined>>,
  factories: ProviderFactories | undefined,
  credentials: WorkspaceCredentials,
): AgentModelProvider {
  if (factories === undefined) {
    throw new ConfigError(
      'the openai provider is not wired into this build; see packages/agent-runtime/src/composition.ts',
    );
  }
  const { openai } = factories;
  const apiKey = credentials.openaiApiKey;
  const baseURL = env.OPENAI_BASE_URL;
  return openai(baseURL === undefined ? { apiKey } : { apiKey, baseURL });
}

/**
 * Builds the provider the turn will stream from.
 *
 * The factories have no default. Whoever calls this has to state what the build wired in, even
 * when the answer is nothing, so that an omission is a decision on the page rather than a value
 * that quietly appears at run time.
 *
 * @param name - Provider name, from {@link resolveProviderName}.
 * @param env - Container environment.
 * @param factories - Factories for the providers this module does not construct on its own.
 * @param credentials - The turn's credentials, read from the file the host placed for it.
 * @returns The provider.
 * @throws ConfigError when the name is unknown or the provider cannot be configured.
 */
export function createProvider(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  factories: ProviderFactories | undefined,
  credentials: WorkspaceCredentials,
): AgentModelProvider {
  if (name === 'fake') {
    return createFakeProvider(env, credentials);
  }
  if (name === DEFAULT_PROVIDER_NAME) {
    return createOpenAiProvider(env, factories, credentials);
  }
  // The name is not echoed: this message becomes a persisted, displayed `turn.failed`, and the
  // operator can read their own environment. Naming the valid values is what helps them.
  throw new ConfigError('AGENT_MODEL_PROVIDER must be "openai" or "fake"');
}
