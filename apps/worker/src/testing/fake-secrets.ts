/**
 * A `SecretsService` over a plain map, seeded with the canaries.
 *
 * Layer: test double.
 *
 * The real service needs a master key file and a database; the processors need only "does
 * `reveal` return a value or `null`". The canaries stand in for the credentials so every test can
 * assert that what the worker injected into the container never comes back out through an event,
 * a row or a log line.
 */
import { last4 } from '@agent-hangar/core';
import type { SecretKey, SecretStatus, SecretsService } from '@agent-hangar/core';

/** Stores secrets in memory; `reveal` hands back exactly what was stored. */
export class FakeSecretsService implements SecretsService {
  private readonly values = new Map<SecretKey, string>();

  /**
   * @param seed - Values present from the start; omit a key to simulate a missing credential.
   */
  constructor(seed: Partial<Record<SecretKey, string>> = {}) {
    for (const [key, value] of Object.entries(seed)) {
      this.values.set(key as SecretKey, value);
    }
  }

  /**
   * Stores a value.
   *
   * @param key - Which credential.
   * @param plaintext - The value.
   * @returns Its masking characters.
   */
  set(key: SecretKey, plaintext: string): Promise<{ last4: string }> {
    this.values.set(key, plaintext);
    return Promise.resolve({ last4: last4(plaintext) });
  }

  /**
   * Forgets a value.
   *
   * @param key - Which credential.
   */
  remove(key: SecretKey): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  /**
   * Masked status of every key.
   *
   * @returns `set` plus the masking characters for each stored value.
   */
  status(): Promise<Record<SecretKey, SecretStatus>> {
    return Promise.resolve({
      GITHUB_PAT: this.statusOf('GITHUB_PAT'),
      OPENAI_API_KEY: this.statusOf('OPENAI_API_KEY'),
    });
  }

  /**
   * Hands back the stored plaintext.
   *
   * @param key - Which credential.
   * @returns The value, or `null` when it was never stored.
   */
  reveal(key: SecretKey): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  /**
   * Builds the masked status of one key.
   *
   * @param key - Which credential.
   * @returns Its status.
   */
  private statusOf(key: SecretKey): SecretStatus {
    const value = this.values.get(key);
    return value === undefined ? { set: false } : { set: true, last4: last4(value) };
  }
}
