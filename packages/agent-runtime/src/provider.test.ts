/**
 * Unit tests for the provider seam.
 *
 * Layer: unit.
 * Goal: `fake` works out of the box, honours a scripted override — including the key that selects
 * an answer and the placeholder that stands in for the workspace credential — `openai` is
 * constructed only through an injected factory and only with a key, and every configuration
 * problem surfaces as a `ConfigError` the turn command can map to
 * `turn.failed { code: 'config' }`.
 * Mocks: a spy factory stands in for the OpenAI provider.
 */
import { ConfigError } from '@agent-hangar/core';
import type { AgentModelProvider, ModelEvent } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createProvider,
  DEFAULT_PROVIDER_NAME,
  GITHUB_CREDENTIAL_PLACEHOLDER,
  resolveProviderName,
} from './provider.js';
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

/**
 * Plays one round-trip of a provider and collects everything it yielded.
 *
 * @param provider - The provider under test.
 * @param prompt - Last user message, which is what selects a script.
 * @returns The events, in order.
 */
async function play(provider: AgentModelProvider, prompt?: string): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of provider.stream({
    model: 'fake-model',
    instructions: '',
    items: prompt === undefined ? [] : [{ role: 'user', content: prompt }],
    tools: [],
  })) {
    events.push(event);
  }
  return events;
}

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
    expect(createProvider('fake', {}, undefined).name).toBe('fake');
  });

  it('uses a script supplied through the environment', async () => {
    // A spec that needs its own answer sets AGENT_FAKE_SCRIPT_JSON on the container.
    const script = { default: [{ events: [{ type: 'text.done', text: 'scripted' }] }] };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
    );
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

  it('selects the answer the last user message is keyed to', async () => {
    // The forwarded script is keyed by prompt, which is the whole reason a caller supplies one:
    // the built-in script answers different text under the same keys, and answers nothing at all
    // under keys it does not carry.
    const script = {
      'print date': [{ events: [{ type: 'text.done', text: 'The date was printed above.' }] }],
      default: [{ events: [{ type: 'text.done', text: 'Acknowledged.' }] }],
    };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
    );

    expect(await play(provider, 'print date')).toStrictEqual([
      { type: 'text.done', text: 'The date was printed above.' },
    ]);
  });

  it('fills the credential placeholder from the workspace environment', async () => {
    // A step has to be able to carry the credential to prove it is redacted on its way to a row,
    // and the script itself must not: it is a file, and a file is not where a credential lives.
    // The workspace already holds the credential, so the substitution happens here.
    const script = {
      default: [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'call-1',
              name: 'write_file',
              arguments: `{"path":"token.txt","content":"${GITHUB_CREDENTIAL_PLACEHOLDER}"}`,
            },
          ],
        },
      ],
    };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script), GITHUB_TOKEN: GITHUB_CANARY },
      undefined,
    );

    expect(await play(provider)).toStrictEqual([
      {
        type: 'tool_call',
        callId: 'call-1',
        name: 'write_file',
        arguments: `{"path":"token.txt","content":"${GITHUB_CANARY}"}`,
      },
    ]);
  });

  it('leaves the placeholder alone when the workspace holds no credential', async () => {
    // Substituting an empty string would turn a step that asks for the credential into one that
    // quietly asks for nothing; the literal placeholder is what makes the omission visible.
    const script = {
      default: [{ events: [{ type: 'text.done', text: GITHUB_CREDENTIAL_PLACEHOLDER }] }],
    };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
    );

    expect(await play(provider)).toStrictEqual([
      { type: 'text.done', text: GITHUB_CREDENTIAL_PLACEHOLDER },
    ]);
  });

  it('leaves the placeholder alone when the credential is empty', async () => {
    // An empty variable is the same statement as an absent one, and must not be substituted in.
    const script = {
      default: [{ events: [{ type: 'text.done', text: GITHUB_CREDENTIAL_PLACEHOLDER }] }],
    };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script), GITHUB_TOKEN: '' },
      undefined,
    );

    expect(await play(provider)).toStrictEqual([
      { type: 'text.done', text: GITHUB_CREDENTIAL_PLACEHOLDER },
    ]);
  });

  it('refuses a script that is not valid JSON, without quoting it', () => {
    // The value came from the container environment, alongside the credentials.
    expect(() => createProvider('fake', { AGENT_FAKE_SCRIPT_JSON: '{oops' }, undefined)).toThrow(
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
    // A build that composed no factories is the state that shipped once and failed on the
    // operator's first real turn; it stays a named failure rather than an undefined dereference.
    expect(() => createProvider('openai', { OPENAI_API_KEY: OPENAI_CANARY }, undefined)).toThrow(
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
    expect(() => createProvider('anthropic', {}, undefined)).toThrow(
      new ConfigError('AGENT_MODEL_PROVIDER must be "openai" or "fake"'),
    );
  });
});
