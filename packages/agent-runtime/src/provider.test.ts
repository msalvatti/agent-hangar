/**
 * Unit tests for the provider seam.
 *
 * Layer: unit.
 * Goal: `fake` works out of the box, honours a scripted override — including the key that selects
 * an answer and the placeholder that stands in for the workspace credential — `openai` is
 * constructed only through an injected factory and only from the credentials the turn was handed,
 * and every configuration problem surfaces as a `ConfigError` the turn command can map to
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

/** What the runtime took off the filesystem before any of this ran. */
const credentials = { githubToken: GITHUB_CANARY, openaiApiKey: OPENAI_CANARY };

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
  /** A workspace with no explicit setting must not silently run against a fake model. */
  it('defaults to the real provider', () => {
    expect(resolveProviderName({})).toBe(DEFAULT_PROVIDER_NAME);
  });

  /** The end-to-end suite and the local demo set this to `fake`. */
  it('honours the environment', () => {
    expect(resolveProviderName({ AGENT_MODEL_PROVIDER: 'fake' })).toBe('fake');
  });
});

describe('createProvider with the fake provider', () => {
  /** This is what makes the end-to-end suite runnable without an API key. */
  it('uses the built-in scripts when the environment supplies none', () => {
    expect(createProvider('fake', {}, undefined, credentials).name).toBe('fake');
  });

  /** A spec that needs its own answer sets AGENT_FAKE_SCRIPT_JSON on the container. */
  it('uses a script supplied through the environment', async () => {
    const script = { default: [{ events: [{ type: 'text.done', text: 'scripted' }] }] };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
      credentials,
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

  /**
   * The forwarded script is keyed by prompt, which is the whole reason a caller supplies one: the
   * built-in script answers different text under the same keys, and answers nothing at all under
   * keys it does not carry.
   */
  it('selects the answer the last user message is keyed to', async () => {
    const script = {
      'print date': [{ events: [{ type: 'text.done', text: 'The date was printed above.' }] }],
      default: [{ events: [{ type: 'text.done', text: 'Acknowledged.' }] }],
    };
    const provider = createProvider(
      'fake',
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
      credentials,
    );

    expect(await play(provider, 'print date')).toStrictEqual([
      { type: 'text.done', text: 'The date was printed above.' },
    ]);
  });

  /**
   * A step has to be able to carry the credential to prove it is redacted on its way to a row, and
   * the script itself must not: it is a file, and a file is not where a credential lives. The
   * workspace already holds the credential, so the substitution happens here.
   */
  it('fills the credential placeholder from the credentials of the turn', async () => {
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
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
      undefined,
      credentials,
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

  /** The value came from the container environment, which is not where a credential lives. */
  it('refuses a script that is not valid JSON, without quoting it', () => {
    expect(() =>
      createProvider('fake', { AGENT_FAKE_SCRIPT_JSON: '{oops' }, undefined, credentials),
    ).toThrow(new ConfigError('AGENT_FAKE_SCRIPT_JSON is not valid JSON'));
  });
});

describe('createProvider with the openai provider', () => {
  /**
   * The runtime never reads the OpenAI SDK itself; the composition supplies the factory. The key
   * comes from the credentials of the turn and never from the environment, which is the whole
   * point of the change that moved it there: an environment entry is readable by every process in
   * the container.
   */
  it('builds it through the injected factory with the key the turn was handed', () => {
    const openai = vi.fn((_options: ProviderFactoryOptions) => stubProvider);
    const provider = createProvider(
      'openai',
      { OPENAI_API_KEY: 'sk-from-the-environment' },
      { openai },
      credentials,
    );
    expect(provider).toBe(stubProvider);
    expect(openai).toHaveBeenCalledWith({ apiKey: OPENAI_CANARY });
  });

  /** Local proxies and compatible gateways are configured this way. */
  it('passes an alternative endpoint when the environment names one', () => {
    const openai = vi.fn((_options: ProviderFactoryOptions) => stubProvider);
    createProvider('openai', { OPENAI_BASE_URL: 'https://proxy.test/v1' }, { openai }, credentials);
    expect(openai).toHaveBeenCalledWith({
      apiKey: OPENAI_CANARY,
      baseURL: 'https://proxy.test/v1',
    });
  });

  /**
   * A build that composed no factories is the state that shipped once and failed on the operator's
   * first real turn; it stays a named failure rather than an undefined dereference.
   */
  it('reports that this build has no factory wired in', () => {
    expect(() => createProvider('openai', {}, undefined, credentials)).toThrow(
      /not wired into this build/,
    );
  });
});

describe('createProvider with an unknown name', () => {
  /** The message becomes a persisted, displayed event. */
  it('names the valid values without echoing the configured one', () => {
    expect(() => createProvider('anthropic', {}, undefined, credentials)).toThrow(
      new ConfigError('AGENT_MODEL_PROVIDER must be "openai" or "fake"'),
    );
  });
});
