/**
 * Unit tests of the real SDK client factory and of the narrow client port.
 *
 * Layer: test.
 *
 * The SDK module is replaced so no client is ever constructed against the real transport, while a
 * compile-time assignment still proves the port has not drifted from the shipped SDK types.
 */
import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OPENAI_CANARY } from '../../testing/canaries.js';

import { createOpenAIClient } from './client.js';
import type { OpenAIResponsesClient } from './client.js';

const { constructorOptions } = vi.hoisted(() => ({ constructorOptions: [] as unknown[] }));

vi.mock('openai', () => {
  class FakeOpenAI {
    readonly responses = {};
    readonly models = {};

    constructor(options: unknown) {
      constructorOptions.push(options);
    }
  }
  return { default: FakeOpenAI };
});

describe('createOpenAIClient', () => {
  beforeEach(() => {
    constructorOptions.length = 0;
  });

  it('disables the SDK retries', () => {
    // Retries belong to the agent runtime; a second loop underneath would multiply the backoff.
    createOpenAIClient({ apiKey: OPENAI_CANARY });
    expect(constructorOptions).toEqual([{ apiKey: OPENAI_CANARY, maxRetries: 0 }]);
  });

  it('omits the base URL unless one was configured', () => {
    // `exactOptionalPropertyTypes` forbids an explicit undefined, and so does the SDK.
    createOpenAIClient({ apiKey: OPENAI_CANARY });
    expect(Object.keys(constructorOptions[0] as object)).not.toContain('baseURL');
  });

  it('forwards a configured base URL', () => {
    // A compatible gateway is addressed by base URL alone; nothing else changes.
    createOpenAIClient({ apiKey: OPENAI_CANARY, baseURL: 'https://gateway.invalid/v1' });
    expect(constructorOptions).toEqual([
      { apiKey: OPENAI_CANARY, maxRetries: 0, baseURL: 'https://gateway.invalid/v1' },
    ]);
  });

  it('keeps the narrow port assignable from the real SDK client', () => {
    // Compile-time check: this assignment fails `tsc` the moment the SDK surface drifts.
    const narrow: (client: OpenAI) => OpenAIResponsesClient = (client) => client;
    expect(narrow).toBeTypeOf('function');
  });
});
