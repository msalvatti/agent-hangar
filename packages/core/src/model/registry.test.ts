/**
 * Unit tests of the model provider registry.
 *
 * Layer: test.
 *
 * The real client factory is replaced so no SDK client is constructed and no credential shape is
 * handed to a transport; the tests assert on the options the registry would have passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../errors.js';
import { OPENAI_CANARY } from '../testing/canaries.js';

import { createFakeOpenAIClient } from './openai/fake-client.js';
import { createModelProvider, isModelProviderName, MODEL_PROVIDER_NAMES } from './registry.js';

const { createOpenAIClient } = vi.hoisted(() => ({ createOpenAIClient: vi.fn() }));

vi.mock('./openai/client.js', () => ({ createOpenAIClient }));

describe('MODEL_PROVIDER_NAMES', () => {
  it('matches the names the environment schema accepts', () => {
    // One list: a name the schema allows but the registry cannot build would fail at runtime.
    expect([...MODEL_PROVIDER_NAMES]).toEqual(['openai', 'fake']);
  });
});

describe('isModelProviderName', () => {
  it('accepts the known names and rejects everything else', () => {
    // The guard is what turns an arbitrary environment string into a buildable name.
    expect(isModelProviderName('openai')).toBe(true);
    expect(isModelProviderName('fake')).toBe(true);
    expect(isModelProviderName('other')).toBe(false);
    expect(isModelProviderName(42)).toBe(false);
    expect(isModelProviderName(undefined)).toBe(false);
  });
});

describe('createModelProvider', () => {
  beforeEach(() => {
    createOpenAIClient.mockReset();
    createOpenAIClient.mockReturnValue(createFakeOpenAIClient());
  });

  it('builds the OpenAI provider from a key alone', () => {
    // The worker reveals the key per turn and hands it straight in.
    const provider = createModelProvider('openai', { openai: { apiKey: OPENAI_CANARY } });
    expect(provider.name).toBe('openai');
    expect(createOpenAIClient).toHaveBeenCalledWith({ apiKey: OPENAI_CANARY });
  });

  it('forwards a configured base URL', () => {
    // A compatible gateway is selected by base URL; nothing else about the call changes.
    createModelProvider('openai', {
      openai: { apiKey: OPENAI_CANARY, baseURL: 'https://gateway.invalid/v1' },
    });
    expect(createOpenAIClient).toHaveBeenCalledWith({
      apiKey: OPENAI_CANARY,
      baseURL: 'https://gateway.invalid/v1',
    });
  });

  it('uses an injected client without constructing an SDK client', () => {
    // Tests and the doctor pass a client directly; no credential is involved at all.
    const client = createFakeOpenAIClient();
    expect(createModelProvider('openai', { openai: { client } }).name).toBe('openai');
    expect(createOpenAIClient).not.toHaveBeenCalled();
  });

  it('points at Settings when no OpenAI credential is configured', () => {
    // The first run has no key stored; the message has to say where to put one.
    expect(() => createModelProvider('openai')).toThrow(ConfigError);
    expect(() => createModelProvider('openai', { openai: { apiKey: '' } })).toThrow(
      'OpenAI API key is not configured — add it in Settings.',
    );
  });

  it('builds the fake provider from a script', () => {
    // End-to-end runs set AGENT_MODEL_PROVIDER=fake and script the answers.
    const provider = createModelProvider('fake', {
      fake: { script: {}, models: ['fake-model'] },
    });
    expect(provider.name).toBe('fake');
    return expect(provider.listModels()).resolves.toEqual(['fake-model']);
  });

  it('builds the fake provider without any options', () => {
    // A provider with an empty script is still a valid provider; it answers with an error event.
    return expect(createModelProvider('fake').listModels()).resolves.toEqual(['fake-model']);
  });

  it('lists the valid names when the configured one is unknown', () => {
    // The operator sees what to write, without the registry repeating what it read.
    expect(() => createModelProvider('anthropic')).toThrow(
      'Unknown AGENT_MODEL_PROVIDER (expected one of: openai, fake).',
    );
  });

  it('never repeats the configured value in the error', () => {
    // A misconfiguration that pasted a credential into the wrong variable must not leak it.
    const failure = (() => {
      try {
        createModelProvider(OPENAI_CANARY);
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : '';
      }
    })();
    expect(failure).not.toContain(OPENAI_CANARY);
    expect(failure).toContain('Unknown AGENT_MODEL_PROVIDER');
  });
});
