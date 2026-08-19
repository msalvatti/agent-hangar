/**
 * The two chat lists the sidebar renders.
 *
 * Layer: feature (hook).
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';

import { listChats } from '../services/shell-api';

/** Result of {@link useChats}. */
export interface UseChatsResult {
  active: readonly ChatSummary[];
  archived: readonly ChatSummary[];
  status: 'idle' | 'loading' | 'success' | 'error';
  error: Error | undefined;
  refetch: () => Promise<void>;
}

/**
 * Loads the active and archived chat lists, both invalidated by the `chats` key prefix.
 *
 * @returns Both lists, the combined status and a refetch that reloads both.
 */
export function useChats(): UseChatsResult {
  const active = useApiQuery(['chats', 'ACTIVE'], (signal) => listChats('ACTIVE', signal));
  const archived = useApiQuery(['chats', 'ARCHIVED'], (signal) => listChats('ARCHIVED', signal));

  const status =
    active.status === 'error' || archived.status === 'error'
      ? 'error'
      : active.status === 'success' && archived.status === 'success'
        ? 'success'
        : 'loading';

  return {
    active: active.data?.chats ?? [],
    archived: archived.data?.chats ?? [],
    status,
    error: active.error ?? archived.error,
    refetch: async () => {
      await Promise.all([active.refetch(), archived.refetch()]);
    },
  };
}
