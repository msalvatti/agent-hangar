/**
 * SSE-driven transcript state for one chat turn or scheduled-job run.
 *
 * Layer: shared (hook).
 *
 * Opens one `EventSource` per `url`, folds every named `AgentEvent` (plus the server's synthetic
 * `expired` frame) through {@link transcriptReducer}, and reopens the connection — with
 * `Last-Event-ID` replay — after a stall or a hard error.
 */
'use client';

import { agentEventSchema } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import type { Dispatch } from 'react';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { createEventSource as defaultCreateEventSource } from '@/shared/api/client';

import { AGENT_EVENT_TYPES, transcriptReducer } from '../reducer';
import type {
  ConnectionState,
  TranscriptAction,
  TranscriptItem,
  TranscriptState,
  TurnPhase,
} from '../types';
import { STALL_TIMEOUT_MS, createInitialState } from '../types';

/** How often the stall watchdog checks for silence while a turn is active. */
const WATCHDOG_INTERVAL_MS = 5000;

/** `EventSource.CONNECTING`, hardcoded per spec so the hook needs no global `EventSource`. */
const READY_STATE_CONNECTING = 0;

const TERMINAL_EVENT_TYPES: ReadonlySet<AgentEvent['type']> = new Set([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);

/** Factory signature matching `createEventSource` from `@/shared/api/client`. */
export type CreateEventSource = (url: string, init?: { lastEventId?: string }) => EventSource;

/** Options of {@link useTurnEvents}. */
export interface UseTurnEventsOptions {
  /** SSE route, or `null` to stay disconnected (e.g. no turn selected yet). */
  url: string | null;
  /** Set to `false` to suspend the connection without changing `url`. */
  enabled?: boolean;
  /** Persisted history to seed the reducer with, when resuming a chat already in progress. */
  initialItems?: readonly TranscriptItem[];
  /** Turn phase to seed the reducer with. */
  initialPhase?: TurnPhase;
  /** Resume point for the first connection. */
  lastEventId?: string | null;
  /** `EventSource` factory, injectable for tests. */
  createEventSource?: CreateEventSource;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Result of {@link useTurnEvents}. */
export interface UseTurnEventsResult {
  state: TranscriptState;
  dispatch: Dispatch<TranscriptAction>;
  /** Closes the current connection (if any) and reopens it from the last known event id. */
  reconnect: () => void;
}

function parseFrame(raw: string): AgentEvent {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { type: 'protocol.error', reason: 'invalid-json', length: raw.length };
  }
  const result = agentEventSchema.safeParse(json);
  return result.success
    ? result.data
    : { type: 'protocol.error', reason: 'schema-violation', length: raw.length };
}

/**
 * Streams the events of one turn/run into a {@link TranscriptState}.
 *
 * @param options - Route, resume point, and test seams.
 * @returns The current state, its dispatch, and a manual reconnect trigger.
 */
export function useTurnEvents(options: UseTurnEventsOptions): UseTurnEventsResult {
  const {
    url,
    enabled = true,
    initialItems,
    initialPhase,
    lastEventId = null,
    createEventSource = defaultCreateEventSource,
    now = Date.now,
  } = options;

  const [state, dispatch] = useReducer(transcriptReducer, undefined, () =>
    createInitialState({
      ...(initialItems !== undefined ? { items: initialItems } : {}),
      ...(initialPhase !== undefined ? { phase: initialPhase } : {}),
      ...(lastEventId !== null ? { lastEventId } : {}),
    }),
  );

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const createEventSourceRef = useRef(createEventSource);
  useEffect(() => {
    createEventSourceRef.current = createEventSource;
  }, [createEventSource]);

  const nowRef = useRef(now);
  useEffect(() => {
    nowRef.current = now;
  }, [now]);

  const sourceRef = useRef<EventSource | null>(null);
  // Timestamp of the most recent (re)connect attempt. The stall watchdog compares against
  // `max(lastActivityAt, lastOpenedAt)`: without it, reopening a still-stalled connection would
  // not itself count as activity, so the very next 5 s tick would see the same staleness and
  // reopen again — a tight reconnect loop instead of a fresh 45 s grace period per attempt.
  const lastOpenedAtRef = useRef(0);

  const openConnection = useCallback(
    (resumeId: string | null) => {
      if (url === null) {
        return;
      }
      lastOpenedAtRef.current = nowRef.current();
      const source = createEventSourceRef.current(
        url,
        resumeId === null ? undefined : { lastEventId: resumeId },
      );
      sourceRef.current = source;

      source.onopen = () => {
        dispatch({ type: 'connection', connection: 'open' });
      };
      source.onerror = () => {
        const connection: ConnectionState =
          source.readyState === READY_STATE_CONNECTING ? 'reconnecting' : 'closed';
        dispatch({ type: 'connection', connection });
      };

      const handleExpired = () => {
        source.close();
        dispatch({ type: 'connection', connection: 'expired' });
      };
      source.addEventListener('expired', handleExpired);

      const handleFrame = (event: MessageEvent<string>) => {
        const parsed = parseFrame(event.data);
        dispatch({
          type: 'event',
          event: parsed,
          id: event.lastEventId || null,
          now: nowRef.current(),
        });
        if (TERMINAL_EVENT_TYPES.has(parsed.type)) {
          source.close();
          dispatch({ type: 'connection', connection: 'closed' });
        }
      };
      for (const type of AGENT_EVENT_TYPES) {
        source.addEventListener(type, handleFrame);
      }
    },
    [url],
  );

  const reconnect = useCallback(() => {
    sourceRef.current?.close();
    dispatch({ type: 'connection', connection: 'reconnecting' });
    openConnection(stateRef.current.lastEventId);
  }, [openConnection]);

  useEffect(() => {
    if (!enabled || url === null) {
      return;
    }
    dispatch({ type: 'connection', connection: 'connecting' });
    openConnection(lastEventId);

    const watchdog = setInterval(() => {
      const current = stateRef.current;
      const isActive = current.phase === 'preparing' || current.phase === 'running';
      if (!isActive) {
        return;
      }
      const lastActivity = Math.max(current.lastActivityAt ?? 0, lastOpenedAtRef.current);
      if (nowRef.current() - lastActivity > STALL_TIMEOUT_MS) {
        sourceRef.current?.close();
        dispatch({ type: 'connection', connection: 'reconnecting' });
        openConnection(current.lastEventId);
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => {
      clearInterval(watchdog);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [enabled, url, lastEventId, openConnection]);

  return { state, dispatch, reconnect };
}
