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

import { invalidateQueries } from '@/shared/api/use-api-query';
import { useTurnEvents } from '@/shared/transcript';
import type { CreateEventSource, TurnPhase, UseTurnEventsResult } from '@/shared/transcript';

import type { MappedChat } from '../lib/map-chat-detail';

/** Phases after which the stream has nothing left to deliver for the turn it follows. */
const TERMINAL_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  'succeeded',
  'failed',
  'cancelled',
]);

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
 * @param refetch - Reloads the persisted chat; called once when the server can no longer serve the
 *   client's position in the stream.
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
  //
  // It reopens from the start, because the new turn writes to a stream of its own and the reducer's
  // resume point names an entry of the turn before it. Asking to continue from an id the new stream
  // never contained is unanswerable, and the server treats an absent resume point as a window it
  // can no longer serve.
  const followedRef = useRef(activeTurnId);
  useEffect(() => {
    const previous = followedRef.current;
    followedRef.current = activeTurnId;
    if (previous === null || activeTurnId === null || previous === activeTurnId) {
      return;
    }
    reconnect({ fromStart: true });
  }, [activeTurnId, reconnect]);

  // A new `mapped` identity is a new persisted snapshot — the value is memoized on the record it
  // was built from — so the reducer is reseeded from it and the followed turn taken from it.
  useEffect(() => {
    // The pass at mount would reseed with the very snapshot the reducer was created from, so it is
    // skipped: it is a render that produces the state already on screen. Nothing observable tells
    // the two apart, which is why the check carries a directive rather than a test.
    //
    // Stryker disable next-line ConditionalExpression,BlockStatement
    if (seededFrom.current === mapped) {
      return;
    }
    seededFrom.current = mapped;
    dispatch({ type: 'reset', items: mapped.items, phase: mapped.phase });
    setActiveTurnId(mapped.activeTurnId);
  }, [mapped, dispatch]);

  // A terminal event reaches the transcript only. The chat lists render each row's dot from the
  // persisted last-turn status, so without this they keep showing a finished turn as still running.
  //
  // Only the lists are invalidated, never this chat's own detail: reloading it would reseed the
  // reducer from persistence and could momentarily undo the terminal state the stream just
  // delivered. The live transcript is the fresher record of the turn that is on screen.
  const reconciledTurnRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeTurnId === null ||
      !TERMINAL_PHASES.has(state.phase) ||
      reconciledTurnRef.current === activeTurnId
    ) {
      return;
    }
    reconciledTurnRef.current = activeTurnId;
    invalidateQueries(['chats']);
  }, [activeTurnId, state.phase]);

  const expiredRef = useRef(false);
  const recoveringFromExpiry = useRef(false);
  useEffect(() => {
    if (state.connection !== 'expired' || expiredRef.current) {
      return;
    }
    // The server can no longer serve the client's position — the replay cache is gone, or it was
    // trimmed past the resume point — so the persisted chat is the only complete record left.
    expiredRef.current = true;
    recoveringFromExpiry.current = true;
    void refetch();
  }, [state.connection, refetch]);

  // Reconciles the screen with the record the refusal-triggered refetch above just reloaded. Fires
  // once that refetch actually lands — `mapped` changing identity is how a memoized value signals a
  // new persisted snapshot — and only while `recoveringFromExpiry` marks a recovery as outstanding,
  // so an unrelated refetch does not reopen the stream.
  //
  // The reseed the effect above performs is necessary but not sufficient: the url is built from the
  // chat id, which has not changed, so it stays the same string and the connection effect never
  // reopens on its own. `reconnect` is what actually asks for a new stream, and it asks from the
  // start: the only position the reducer holds is the one the server just refused. A chat whose
  // refetched record shows no live turn is left alone — a finished turn has nothing left to stream.
  useEffect(() => {
    if (!recoveringFromExpiry.current) {
      return;
    }
    recoveringFromExpiry.current = false;
    if (mapped.activeTurnId !== null) {
      reconnect({ fromStart: true });
    }
  }, [mapped, reconnect]);

  // Nothing this callback reads changes between renders, so its dependency list is empty — and
  // anything constant added to it would never change either.
  // Stryker disable ArrayDeclaration
  const followTurn = useCallback((turnId: string) => {
    expiredRef.current = false;
    setActiveTurnId(turnId);
  }, []);
  // Stryker restore ArrayDeclaration

  return { ...events, activeTurnId, followTurn };
}
