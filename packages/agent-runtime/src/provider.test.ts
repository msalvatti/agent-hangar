/**
 * Unit tests for the provider seam.
 *
 * Layer: unit.
 * Goal: `fake` works out of the box and honours a scripted override, `openai` is constructed only
 * through an injected factory and only with a key, and every configuration problem surfaces as a
 * `ConfigError` the turn command can map to `turn.failed { code: 'config' }`.
 * Mocks: a spy factory stands in for the OpenAI provider.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentModelProvider } from '@agent-hangar/core';
import { OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createProvider, DEFAULT_PROVIDER_NAME, resolveProviderName } from './provider.js';
import type { ProviderFactoryOptions } from './provider.js';

/** A provider that answers nothing; only its identity matters here. */
const stubProvider: AgentModelProvider = {
  name: 'openai',
  stream: () => ({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
    },
  }),
  listModels: () => Promise.resolve([]),
};

describe('resolveProviderName', () => {
  it('defaults to the real provider', () => {
    // A workspace with no explicit setting must not silently run against a fake model.
    expect(resolveProviderName({})).toBe(DEFAULT_PROVIDER_NAME);
  });

  it('honours the environment', () => {
    // The end-to-end suite and the local demo set this to `fake`.
    expect(resolveProviderName({ AGENT_MODEL_PROVIDER: 'fake' })).toBe('fake');
  });
});

describe('createProvider with the fake provider', () => {
  it('uses the built-in scripts when the environment supplies none', () => {
    // This is what makes the end-to-end suite runnable without an API key.
    expect(createProvider('fake', {}).name).toBe('fake');
  });

  it('uses a script supplied through the environment', async () => {
    // A spec that needs its own answer sets AGENT_FAKE_SCRIPT_JSON on the container.
    const script = { default: [{ events: [{ type: 'text.done', text: 'scripted' }] }] };
    const provider = createProvider('fake', { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) });
    const events = [];
    for await (const event of provider.stream({
      model: 'fake-model',
      instructions: '',
      items: [],
      tools: [],
    })) {
      events.push(event);
    }
    expect(events).toStrictEqual([{ type: 'text.done', text: 'scripted' }]);
  });

  it('refuses a script that is not valid JSON, without quoting it', () => {
    // The value came from the container environment, alongside the credentials.
    expect(() => createProvider('fake', { AGENT_FAKE_SCRIPT_JSON: '{oops' })).toThrow(
      new ConfigError('AGENT_FAKE_SCRIPT_JSON is not valid JSON'),
    );
  });
});

describe('createProvider with the openai provider', () => {
  it('builds it through the injected factory with the key from the environment', () => {
    // The runtime never reads the OpenAI SDK itself; the composition supplies the factory.
    const openai = vi.fn((_options: ProviderFactoryOptions) => stubProvider);
    const provider = createProvider('openai', { OPENAI_API_KEY: OPENAI_CANARY }, { openai });
    expect(provider).toBe(stubProvider);
    expect(openai).toHaveBeenCalledWith({ apiKey: OPENAI_CANARY });
  });

  it('passes an alternative endpoint when the environment names one', () => {
    // Local proxies and compatible gateways are configured this way.
    const openai = vi.fn((_options: ProviderFactoryOptions) => stubProvider);
    createProvider(
      'openai',
      { OPENAI_API_KEY: OPENAI_CANARY, OPENAI_BASE_URL: 'https://proxy.test/v1' },
      { openai },
    );
    expect(openai).toHaveBeenCalledWith({
      apiKey: OPENAI_CANARY,
      baseURL: 'https://proxy.test/v1',
    });
  });

  it('reports that this build has no factory wired in', () => {
    // Until the wiring lands, `AGENT_MODEL_PROVIDER=openai` has to say so out loud.
    expect(() => createProvider('openai', { OPENAI_API_KEY: OPENAI_CANARY })).toThrow(
      /not wired into this build/,
    );
  });

  it.each([
    ['no key at all', {}],
    ['an empty key', { OPENAI_API_KEY: '' }],
  ])('reports %s before calling the factory', (_name, env) => {
    // Settings is where the operator fixes this, and the UI links there from the failure.
    const openai = vi.fn((_options: ProviderFactoryOptions) => stubProvider);
    expect(() => createProvider('openai', env, { openai })).toThrow(/OPENAI_API_KEY is not set/);
    expect(openai).not.toHaveBeenCalled();
  });
});

describe('createProvider with an unknown name', () => {
  it('names the valid values without echoing the configured one', () => {
    // The message becomes a persisted, displayed event.
    expect(() => createProvider('anthropic', {})).toThrow(
      new ConfigError('AGENT_MODEL_PROVIDER must be "openai" or "fake"'),
    );
  });
});
