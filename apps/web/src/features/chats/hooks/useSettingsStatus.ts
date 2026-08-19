/**
 * Reads which credentials are configured, so the home screen can gate the composer.
 *
 * Layer: feature (hook).
 */
'use client';

import type { ApiResponse } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { getSettingsStatus } from '../services/chats-api';

/** Result of {@link useSettingsStatus}: the query result plus the gate the composer reads. */
export interface UseSettingsStatusResult extends UseApiQueryResult<ApiResponse<'getSettings'>> {
  /** `true` once the status is known and either credential is missing. */
  missing: boolean;
}

/**
 * Fetches `GET /api/settings` under the `settings` query key.
 *
 * @returns The query result and whether a credential is missing.
 */
export function useSettingsStatus(): UseSettingsStatusResult {
  const query = useApiQuery(['settings'], (signal) => getSettingsStatus(signal));
  const missing =
    query.data === undefined ? false : !(query.data.githubPat.set && query.data.openaiKey.set);
  return { ...query, missing };
}
