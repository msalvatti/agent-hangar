/**
 * Unit tests for the secrets service.
 *
 * Layer: unit.
 * Goal: `set` stores an envelope and nothing else, `status` reports masked state for both keys,
 * `reveal` returns the original credential and refuses anything that does not authenticate, and
 * the repository never holds a plaintext.
 * Mocks: the in-memory `SecretRepository` double and `StaticMasterKey`.
 */
import { describe, expect, it } from 'vitest';

import { SecretIntegrityError } from '../errors.ts';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.ts';
import { createInMemoryRepositories } from '../testing/in-memory-repositories.ts';
import type { InMemoryRepositories } from '../testing/in-memory-repositories.ts';

import { AUTH_TAG_BYTES, IV_BYTES, encryptSecret } from './crypto.ts';
import { InvalidSecretError } from './errors.ts';
import { MASTER_KEY_BYTES, StaticMasterKey } from './master-key.ts';
import { createSecretsService } from './secrets-service.ts';
import type { SecretsService } from './types.ts';

/**
 * Builds a service over a fresh in-memory repository.
 *
 * @param version - Master key version the service seals with.
 * @returns The service and the repositories behind it.
 */
function createHarness(version = 1): { service: SecretsService; repos: InMemoryRepositories } {
  const repos = createInMemoryRepositories();
  const service = createSecretsService({
    repository: repos.secrets,
    masterKey: new StaticMasterKey(Buffer.alloc(MASTER_KEY_BYTES, 9), version),
  });
  return { service, repos };
}

/**
 * Renders every stored secret row as text, buffers included.
 *
 * @param repos - Repositories whose store is inspected.
 * @returns One string holding every byte the repository kept.
 */
function dumpSecretRows(repos: InMemoryRepositories): string {
  return [...repos.store.secrets.values()]
    .map((row) =>
      [
        JSON.stringify({ key: row.key, keyVersion: row.keyVersion, last4: row.last4 }),
        Buffer.from(row.ciphertext).toString('utf8'),
        Buffer.from(row.ciphertext).toString('hex'),
        Buffer.from(row.iv).toString('utf8'),
        Buffer.from(row.authTag).toString('utf8'),
      ].join('|'),
    )
    .join('\n');
}

describe('createSecretsService', () => {
  /**
   * The save path: the caller gets only the masking hint back, and the row carries a complete,
   * correctly sized envelope stamped with the key version in use.
   */
  it('stores an envelope and returns only the masking hint', async () => {
    const { service, repos } = createHarness();

    const result = await service.set('GITHUB_PAT', GITHUB_CANARY);
    const row = await repos.secrets.get('GITHUB_PAT');

    expect(result).toEqual({ last4: GITHUB_CANARY.slice(-4) });
    expect(row?.keyVersion).toBe(1);
    expect(row?.iv).toHaveLength(IV_BYTES);
    expect(row?.authTag).toHaveLength(AUTH_TAG_BYTES);
    expect(row?.last4).toBe(GITHUB_CANARY.slice(-4));
  });

  /**
   * The single most important assertion of the secrets store: whatever the repository persists —
   * and therefore whatever reaches Postgres — contains no credential in any encoding.
   */
  it('never lets a plaintext credential reach the repository', async () => {
    const { service, repos } = createHarness();

    await service.set('GITHUB_PAT', GITHUB_CANARY);
    await service.set('OPENAI_API_KEY', OPENAI_CANARY);

    assertNoCanary(dumpSecretRows(repos));
  });

  /**
   * The worker path: what was stored comes back byte-for-byte, for both credentials.
   */
  it('reveals the exact credential that was stored', async () => {
    const { service } = createHarness();

    await service.set('GITHUB_PAT', GITHUB_CANARY);
    await service.set('OPENAI_API_KEY', OPENAI_CANARY);

    expect(await service.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await service.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);
  });

  /**
   * A key the user never filled in is a normal state, not an error: the worker skips injecting
   * it rather than failing the turn.
   */
  it('reveals null for a key that was never set', async () => {
    const { service } = createHarness();

    expect(await service.reveal('OPENAI_API_KEY')).toBeNull();
  });

  /**
   * Saving again replaces the credential outright — there is one row per key — and both the
   * revealed value and the masking hint follow the new value.
   */
  it('replaces a previously stored credential', async () => {
    const { service } = createHarness();
    await service.set('GITHUB_PAT', GITHUB_CANARY);

    await service.set('GITHUB_PAT', `${GITHUB_CANARY}xyz9`);

    expect(await service.reveal('GITHUB_PAT')).toBe(`${GITHUB_CANARY}xyz9`);
    expect((await service.status()).GITHUB_PAT.last4).toBe('xyz9');
  });

  /**
   * Removing a credential must leave nothing behind: no row to reveal and no masked status.
   */
  it('removes a stored credential', async () => {
    const { service } = createHarness();
    await service.set('GITHUB_PAT', GITHUB_CANARY);

    await service.remove('GITHUB_PAT');

    expect(await service.reveal('GITHUB_PAT')).toBeNull();
    expect((await service.status()).GITHUB_PAT).toEqual({ set: false });
  });

  /**
   * The Settings page renders both fields whatever the state, so `status` always answers for both
   * keys and exposes only the mask and the timestamp — never ciphertext.
   */
  it('reports both keys in every state without exposing ciphertext', async () => {
    const { service } = createHarness();
    await service.set('OPENAI_API_KEY', OPENAI_CANARY);

    const status = await service.status();

    expect(Object.keys(status).sort()).toEqual(['GITHUB_PAT', 'OPENAI_API_KEY']);
    expect(status.GITHUB_PAT).toEqual({ set: false });
    expect(status.OPENAI_API_KEY.set).toBe(true);
    expect(status.OPENAI_API_KEY.last4).toBe(OPENAI_CANARY.slice(-4));
    expect(status.OPENAI_API_KEY.updatedAt).toBeInstanceOf(Date);
    assertNoCanary(JSON.stringify(status));
  });

  /**
   * An empty field is a mistake, not a credential: it is refused before anything is written, so
   * a stored value is never silently replaced by nothing.
   */
  it('refuses an empty value and writes nothing', async () => {
    const { service, repos } = createHarness();

    await expect(service.set('GITHUB_PAT', '')).rejects.toThrow(InvalidSecretError);
    expect(repos.store.secrets.size).toBe(0);
  });

  /**
   * A row written under a different master key version — a restored backup, a rotated key — must
   * fail loudly instead of handing the worker a broken credential.
   */
  it('refuses to reveal a row sealed with another key version', async () => {
    const { service, repos } = createHarness();
    const foreign = encryptSecret(
      GITHUB_CANARY,
      { key: Buffer.alloc(MASTER_KEY_BYTES, 9), version: 2 },
      'agent-hangar:secret:GITHUB_PAT',
    );
    await repos.secrets.upsert('GITHUB_PAT', { ...foreign, last4: 'aaaa' });

    await expect(service.reveal('GITHUB_PAT')).rejects.toThrow(SecretIntegrityError);
  });

  /**
   * A row whose ciphertext was edited in the database fails authentication on the way out, which
   * is the property the whole envelope exists for.
   */
  it('refuses to reveal a row with a corrupted ciphertext', async () => {
    const { service, repos } = createHarness();
    await service.set('GITHUB_PAT', GITHUB_CANARY);
    const row = (await repos.secrets.get('GITHUB_PAT'))!;
    const corrupted = Buffer.from(row.ciphertext);
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0);
    await repos.secrets.upsert('GITHUB_PAT', {
      ciphertext: corrupted,
      iv: row.iv,
      authTag: row.authTag,
      keyVersion: row.keyVersion,
      last4: row.last4,
    });

    await expect(service.reveal('GITHUB_PAT')).rejects.toThrow(SecretIntegrityError);
  });

  /**
   * Both rows are sealed under the same master key, so authentication alone cannot tell them
   * apart: only the per-row binding does. Swapping the two complete envelopes in the database must
   * make `reveal` fail rather than hand the GitHub token to whoever asked for the OpenAI key.
   */
  it('refuses to reveal a row whose envelope was swapped with the other key', async () => {
    const { service, repos } = createHarness();
    await service.set('GITHUB_PAT', GITHUB_CANARY);
    await service.set('OPENAI_API_KEY', OPENAI_CANARY);
    const github = (await repos.secrets.get('GITHUB_PAT'))!;
    const openai = (await repos.secrets.get('OPENAI_API_KEY'))!;

    await repos.secrets.upsert('GITHUB_PAT', { ...openai, last4: github.last4 });
    await repos.secrets.upsert('OPENAI_API_KEY', { ...github, last4: openai.last4 });

    await expect(service.reveal('GITHUB_PAT')).rejects.toThrow(SecretIntegrityError);
    await expect(service.reveal('OPENAI_API_KEY')).rejects.toThrow(SecretIntegrityError);
  });

  /**
   * Rotation is expressed by the provider's version, and every envelope written afterwards has to
   * carry it so a later read can tell which key opens the row.
   */
  it('stamps the provider key version on new envelopes', async () => {
    const { service, repos } = createHarness(4);

    await service.set('GITHUB_PAT', GITHUB_CANARY);

    expect((await repos.secrets.get('GITHUB_PAT'))?.keyVersion).toBe(4);
  });
});
