/**
 * Runs a failed turn again and reports whether it went back on the queue.
 *
 * Layer: feature (hook).
 *
 * Deliberately not part of `useSendMessage`: a retry sends no prompt and creates no turn, so it
 * has neither of that hook's two outputs. Sharing it would mean a `lastPrompt` the retry never
 * reads and a returned turn id it did not mint.
 */
'use client';

import { useCallback, useState } from 'react';

import { retryTurn } from '../services/chats-api';

/** Result of {@link useRetryTurn}. */
export interface UseRetryTurnResult {
  /** Re-runs `turnId`; resolves to `true` when it is queued again, `false` when the API refused. */
  retry: (turnId: string) => Promise<boolean>;
  busy: boolean;
  /** Why the last retry was refused, or `undefined` when none was. */
  error: string | undefined;
}

/**
 * Wires the retry action to its endpoint and keeps the failure it may answer with.
 *
 * The message is kept rather than discarded because a refusal is the whole answer here: the retry
 * changes nothing on screen when it fails, so without it the button would look inert.
 *
 * @returns The retry action and its state.
 */
export function useRetryTurn(): UseRetryTurnResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Nothing this callback reads changes between renders, so its dependency list is empty — and
  // anything constant added to it would never change either.
  // Stryker disable ArrayDeclaration
  const retry = useCallback(async (turnId: string): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await retryTurn(turnId);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  // Stryker restore ArrayDeclaration

  return { retry, busy, error };
}
