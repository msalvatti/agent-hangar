/**
 * Loads one chat and maps it into the transcript model.
 *
 * Layer: feature (hook).
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';
import { useMemo } from 'react';

import { ApiClientError } from '@/shared/api/client';
import { useApiQuery } from '@/shared/api/use-api-query';

import { mapChatDetail } from '../lib/map-chat-detail';
import type { MappedChat } from '../lib/map-chat-detail';
import { getChat } from '../services/chats-api';

/** HTTP status the API answers for an unknown chat. */
const HTTP_NOT_FOUND = 404;

/** Result of {@link useChat}. */
export interface UseChatResult {
  status: 'idle' | 'loading' | 'success' | 'error';
  chat: ChatSummary | undefined;
  /** The persisted transcript, or `undefined` before the chat has loaded. */
  mapped: MappedChat | undefined;
  error: Error | undefined;
  /** `true` when the failure was specifically an unknown chat id. */
  notFound: boolean;
  /**
   * Newest persisted turn of the chat, or `null` when it has none.
   *
   * The transcript keeps only the phase of that turn, and a turn that has finished is not one the
   * stream follows, so a failure reloaded from history would otherwise leave the screen with no id
   * to retry. Read from the payload rather than from the mapped transcript because it is a fact
   * about the chat, not a row of it.
   */
  lastTurnId: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetches `GET /api/chats/:id` under the `chat` key and rebuilds its transcript.
 *
 * @param id - Chat id.
 * @returns The chat, its mapped transcript and the query state.
 */
export function useChat(id: string): UseChatResult {
  const query = useApiQuery(['chat', id], (signal) => getChat(id, signal));
  const detail = query.data;
  const mapped = useMemo(
    () => (detail === undefined ? undefined : mapChatDetail(detail)),
    [detail],
  );
  return {
    status: query.status,
    chat: detail?.chat,
    mapped,
    error: query.error,
    notFound: query.error instanceof ApiClientError && query.error.status === HTTP_NOT_FOUND,
    lastTurnId: detail?.turns.at(-1)?.id ?? null,
    refetch: query.refetch,
  };
}
