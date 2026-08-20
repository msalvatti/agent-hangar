/**
 * In-memory {@link SecretsService} double.
 *
 * Layer: test double.
 *
 * It records every `reveal` so a suite can assert the settings routes never call it: those routes
 * are the one place plaintext enters the process, and they must be able to store and mask a value
 * without ever decrypting one back.
 */
import type { SecretKey, SecretsService, SecretStatus } from '@agent-hangar/core';

/** How many trailing characters the UI is allowed to see. */
const LAST4_LENGTH = 4;

/** In-memory stand-in for the encrypting secrets service. */
export class FakeSecretsService implements SecretsService {
  /** Keys passed to {@link FakeSecretsService.reveal}, in order. */
  readonly revealCalls: SecretKey[] = [];

  /** Set to make the next `set` reject, exercising the write-failure path. */
  setFailure: Error | null = null;

  private readonly values = new Map<SecretKey, { value: string; updatedAt: Date }>();

  /**
   * @param seed - Values present before the test runs.
   * @param now - Timestamp stamped on every write.
   */
  constructor(
    seed: Partial<Record<SecretKey, string>> = {},
    private readonly now: Date = new Date('2026-08-19T10:00:00.000Z'),
  ) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key as SecretKey, { value, updatedAt: now });
    }
  }

  /**
   * @param key - Secret to store.
   * @param plaintext - Value to store.
   * @returns The masked tail the UI displays.
   * @throws Error When {@link FakeSecretsService.setFailure} is set.
   */
  set(key: SecretKey, plaintext: string): Promise<{ last4: string }> {
    if (this.setFailure !== null) {
      return Promise.reject(this.setFailure);
    }
    this.values.set(key, { value: plaintext, updatedAt: this.now });
    return Promise.resolve({ last4: plaintext.slice(-LAST4_LENGTH) });
  }

  /**
   * @param key - Secret to forget.
   * @returns Resolves once forgotten.
   */
  remove(key: SecretKey): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  /**
   * @returns Masked status of every key.
   */
  status(): Promise<Record<SecretKey, SecretStatus>> {
    return Promise.resolve({
      GITHUB_PAT: this.statusOf('GITHUB_PAT'),
      OPENAI_API_KEY: this.statusOf('OPENAI_API_KEY'),
    });
  }

  /**
   * @param key - Secret to decrypt.
   * @returns The stored value, or `null`.
   */
  reveal(key: SecretKey): Promise<string | null> {
    this.revealCalls.push(key);
    return Promise.resolve(this.values.get(key)?.value ?? null);
  }

  /**
   * @param key - Secret to describe.
   * @returns Its masked status.
   */
  private statusOf(key: SecretKey): SecretStatus {
    const stored = this.values.get(key);
    return stored === undefined
      ? { set: false }
      : { set: true, last4: stored.value.slice(-LAST4_LENGTH), updatedAt: stored.updatedAt };
  }
}
