/**
 * Keeps the live transcript of a chat in sync with the persisted one.
 *
 * Layer: feature (hook).
 *
 * Three things have to agree: the history the API returns, the events the stream delivers, and
 * which turn the stream is following. This hook owns that reconciliation so the view only renders.
 */
'use client';

import { buildPath, routes } from '@agent-hangar/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useTurnEvents } from '@/shared/transcript';
import type { CreateEventSource, UseTurnEventsResult } from '@/shared/transcript';

import type { MappedChat } from '../lib/map-chat-detail';

/** Result of {@link useChatStream}. */
export interface UseChatStreamResult extends UseTurnEventsResult {
  /** Turn the stream is following, or `null` when the newest turn has finished. */
  activeTurnId: string | null;
  /** Follows a newly queued turn (after a follow-up prompt). */
  followTurn: (turnId: string) => void;
}

/**
 * Streams the chat's active turn, reseeding the reducer whenever the persisted chat is refetched.
 *
 * @param chatId - Chat id.
 * @param mapped - The persisted transcript, remapped on every refetch.
 * @param refetch - Reloads the persisted chat; called once when the server expires the stream.
 * @param createEventSource - `EventSource` factory, injectable for tests.
 * @returns The transcript state, its dispatch, the followed turn and a way to change it.
 */
export function useChatStream(
  chatId: string,
  mapped: MappedChat,
  refetch: () => Promise<void>,
  createEventSource: CreateEventSource | undefined,
): UseChatStreamResult {
  const [activeTurnId, setActiveTurnId] = useState<string | null>(mapped.activeTurnId);
  const seededFrom = useRef(mapped);

  const events = useTurnEvents({
    url: activeTurnId === null ? null : buildPath(routes.chatEvents, { id: chatId }),
    initialItems: mapped.items,
    initialPhase: mapped.phase,
    createEventSource,
  });
  const { dispatch, reconnect, state } = events;

  // The SSE route is per chat, not per turn, so following a newly queued turn does not change the
  // url the hook watches: the connection has to be reopened explicitly. Going from "no turn" to a
  // turn already opens it (the url flips from `null`), and going back to none closes it.
  const followedRef = useRef(activeTurnId);
  useEffect(() => {
    const previous = followedRef.current;
    followedRef.current = activeTurnId;
    if (previous === null || activeTurnId === null || previous === activeTurnId) {
      return;
    }
    reconnect();
  }, [activeTurnId, reconnect]);

  useEffect(() => {
    if (seededFrom.current === mapped) {
      return;
    }
    seededFrom.current = mapped;
    dispatch({ type: 'reset', items: mapped.items, phase: mapped.phase });
    setActiveTurnId(mapped.activeTurnId);
  }, [mapped, dispatch]);

  const expiredRef = useRef(false);
  useEffect(() => {
    if (state.connection !== 'expired' || expiredRef.current) {
      return;
    }
    // The server dropped the replay window; the persisted chat is now the only complete record.
    expiredRef.current = true;
    void refetch();
  }, [state.connection, refetch]);

  const followTurn = useCallback((turnId: string) => {
    expiredRef.current = false;
    setActiveTurnId(turnId);
  }, []);

  return { ...events, activeTurnId, followTurn };
}
