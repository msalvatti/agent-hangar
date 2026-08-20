/**
 * Query hook for the masked settings status.
 *
 * Layer: hook.
 */
'use client';

import type { SettingsStatus } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { getSettings } from '../services/settings-api';

/**
 * Loads the masked secret status and active model, registered under the `['settings']` query key.
 *
 * @returns The settings query state.
 */
export function useSettings(): UseApiQueryResult<SettingsStatus> {
  return useApiQuery(['settings'], (signal) => getSettings(signal));
}
