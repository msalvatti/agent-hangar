/**
 * Typed HTTP calls for settings (masked secret status, secret mutations, health), over the shared
 * `apiFetch` client.
 *
 * Layer: service.
 */
import type { HealthResponse, SecretKey, SettingsStatus } from '@agent-hangar/core';

import { apiFetch } from '@/shared/api/client';

/**
 * Fetches the masked status of every secret and the active model.
 *
 * @param signal - Aborts the request.
 * @returns The settings status.
 */
export async function getSettings(signal?: AbortSignal): Promise<SettingsStatus> {
  return apiFetch('getSettings', signal === undefined ? {} : { signal });
}

/**
 * Saves a secret's plaintext value.
 *
 * @param key - The secret to save.
 * @param value - The plaintext value; never logged or returned.
 * @returns The saved secret's last 4 characters.
 */
export async function putSecret(key: SecretKey, value: string): Promise<string> {
  const result = await apiFetch('putSecret', { params: { key }, body: { value } });
  return result.last4;
}

/**
 * Removes a secret.
 *
 * @param key - The secret to remove.
 */
export async function deleteSecret(key: SecretKey): Promise<void> {
  await apiFetch('deleteSecret', { params: { key } });
}

/**
 * Fetches the instance's health summary.
 *
 * @param signal - Aborts the request.
 * @returns The health response.
 */
export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch('getHealth', signal === undefined ? {} : { signal });
}
