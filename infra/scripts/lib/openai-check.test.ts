/**
 * Unit tests for `openaiCheck`.
 *
 * Layer: unit.
 * Goal: every outcome (ok, model-missing, auth, network, no-key) reports the documented line and
 * exit code, the revealed key is never printed, and a canary used as the stored key never leaks
 * into the output.
 * Mocks: an in-memory `SecretRepository` and the real `SecretsService` over a temp key file; a
 * hand-written `ModelLister` fake (no real OpenAI SDK call).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ModelProviderError } from '../../../packages/core/src/model/openai/errors.js';
import { OPENAI_CANARY, assertNoCanary } from '../../../packages/core/src/testing/canaries.js';
import { createInMemoryRepositories } from '../../../packages/core/src/testing/in-memory-repositories.js';

import { createFileBackedSecretsService } from './file-backed-secrets-service.js';
import {
  EXIT_AUTH,
  EXIT_MODEL_MISSING,
  EXIT_NETWORK,
  EXIT_NO_KEY,
  openaiCheck,
} from './openai-check.js';
import type { ModelLister, OpenaiCheckDeps } from './openai-check.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempKeyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-openai-check-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  writeFileSync(keyPath, `${'ef'.repeat(32)}\n`, { mode: 0o600 });
  return keyPath;
}

/** Builds deps whose secrets store already holds `OPENAI_API_KEY = OPENAI_CANARY`. */
async function depsWithStoredKey(
  overrides: Partial<OpenaiCheckDeps> = {},
): Promise<OpenaiCheckDeps> {
  const repository = createInMemoryRepositories().secrets;
  const keyPath = tempKeyPath();
  const service = createFileBackedSecretsService(repository, keyPath);
  await service.set('OPENAI_API_KEY', OPENAI_CANARY);
  return {
    env: {},
    loadConfig: () => ({
      DATABASE_URL: 'unused',
      MASTER_KEY_PATH: keyPath,
      OPENAI_MODEL: 'gpt-5.6-sol',
      OPENAI_BASE_URL: undefined,
    }),
    createDatabaseClient: () => ({}),
    assertDatabaseReachable: () => Promise.resolve(),
    createSecretRepository: () => repository,
    createSecretsService: createFileBackedSecretsService,
    createProvider: () => {
      throw new Error('createProvider must be overridden per test');
    },
    ...overrides,
  };
}

function lister(fn: ModelLister['listModels']): ModelLister {
  return { listModels: fn };
}

describe('openaiCheck', () => {
  /**
   * The configured model is in the reachable list: `ok <model>`, exit 0.
   */
  it('reports ok when the configured model is reachable', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () => lister(() => Promise.resolve(['gpt-5.6-sol', 'other-model'])),
    });
    const result = await openaiCheck(deps);
    expect(result).toEqual({ line: 'ok gpt-5.6-sol', exitCode: 0 });
  });

  /**
   * The configured model is absent: `model-missing` lists up to five reachable ids.
   */
  it('reports model-missing with up to five available ids', async () => {
    const available = ['a', 'b', 'c', 'd', 'e', 'f'];
    const deps = await depsWithStoredKey({
      createProvider: () => lister(() => Promise.resolve(available)),
    });
    const result = await openaiCheck(deps);
    expect(result.exitCode).toBe(EXIT_MODEL_MISSING);
    expect(result.line).toBe('model-missing gpt-5.6-sol (available: a, b, c, d, e, …)');
  });

  /**
   * A short list of available ids is not truncated with an ellipsis.
   */
  it('does not append an ellipsis when five or fewer ids are available', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () => lister(() => Promise.resolve(['a', 'b'])),
    });
    const result = await openaiCheck(deps);
    expect(result.line).toBe('model-missing gpt-5.6-sol (available: a, b)');
  });

  /**
   * An `auth`-classified provider error reports `auth`, exit 6, regardless of its message.
   */
  it('reports auth on an auth-classified provider error', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () =>
        lister(() => Promise.reject(new ModelProviderError('auth', 'invalid api key', false))),
    });
    const result = await openaiCheck(deps);
    expect(result).toEqual({ line: 'auth', exitCode: EXIT_AUTH });
  });

  /**
   * Any other classified provider error falls into the network bucket with its safe message.
   */
  it('reports network on any other classified provider error', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () =>
        lister(() => Promise.reject(new ModelProviderError('network', 'connection reset', true))),
    });
    const result = await openaiCheck(deps);
    expect(result).toEqual({ line: 'network connection reset', exitCode: EXIT_NETWORK });
  });

  /**
   * An error that is not a classified `ModelProviderError` still falls into the network bucket,
   * with a fixed message rather than repeating whatever the unclassified error said.
   */
  it('reports network with a fixed message for an unclassified provider error', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () => lister(() => Promise.reject(new Error('boom'))),
    });
    const result = await openaiCheck(deps);
    expect(result).toEqual({ line: 'network unexpected error', exitCode: EXIT_NETWORK });
  });

  /**
   * No stored key at all: `no-key`, exit 8, and the provider is never constructed.
   */
  it('reports no-key when nothing is stored', async () => {
    const repository = createInMemoryRepositories().secrets;
    const keyPath = tempKeyPath();
    let providerBuilt = false;
    const result = await openaiCheck({
      env: {},
      loadConfig: () => ({
        DATABASE_URL: 'unused',
        MASTER_KEY_PATH: keyPath,
        OPENAI_MODEL: 'gpt-5.6-sol',
        OPENAI_BASE_URL: undefined,
      }),
      createDatabaseClient: () => ({}),
      assertDatabaseReachable: () => Promise.resolve(),
      createSecretRepository: () => repository,
      createSecretsService: createFileBackedSecretsService,
      createProvider: () => {
        providerBuilt = true;
        return lister(() => Promise.resolve([]));
      },
    });
    expect(result).toEqual({ line: 'no-key', exitCode: EXIT_NO_KEY });
    expect(providerBuilt).toBe(false);
  });

  /**
   * A failure while revealing the key (unreachable database, missing master key) reports network
   * with the underlying message rather than throwing out of the helper.
   */
  it('reports a fixed network message when revealing the key fails', async () => {
    const deps = await depsWithStoredKey({
      assertDatabaseReachable: () => Promise.reject(new Error('db down')),
    });
    const result = await openaiCheck(deps);
    expect(result).toEqual({ line: 'network unexpected error', exitCode: EXIT_NETWORK });
  });

  /**
   * The stored canary never appears in any outcome's line.
   */
  it('never prints the revealed key', async () => {
    const deps = await depsWithStoredKey({
      createProvider: () => lister(() => Promise.resolve(['gpt-5.6-sol'])),
    });
    const result = await openaiCheck(deps);
    assertNoCanary(result.line);
  });
});
