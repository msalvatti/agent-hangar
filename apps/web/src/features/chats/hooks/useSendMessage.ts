/**
 * Posts a follow-up prompt and reports the turn it queued.
 *
 * Layer: feature (hook).
 */
'use client';

import { useCallback, useState } from 'react';

import { postMessage } from '../services/chats-api';

/** Result of {@link useSendMessage}. */
export interface UseSendMessageResult {
  /** Posts `prompt`; resolves to the queued turn id, or `null` when the request failed. */
  send: (prompt: string) => Promise<string | null>;
  /** Re-sends the last prompt, for the Retry action of a failed turn. */
  retryLast: () => Promise<string | null>;
  busy: boolean;
  error: string | undefined;
  /** The most recent prompt sent through this hook, or seeded from history. */
  lastPrompt: string | null;
}

/**
 * Sends follow-up prompts to one chat.
 *
 * @param id - Chat id.
 * @param initialPrompt - Newest prompt already in the persisted history, for Retry. Read once:
 * the hook mounts with the loaded chat, and every later prompt comes through `send`.
 * @returns The send action, its retry, and their state.
 */
export function useSendMessage(id: string, initialPrompt: string | null): UseSendMessageResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lastPrompt, setLastPrompt] = useState<string | null>(initialPrompt);

  const send = useCallback(
    async (prompt: string): Promise<string | null> => {
      setBusy(true);
      setError(undefined);
      setLastPrompt(prompt);
      try {
        const { turnId } = await postMessage(id, prompt);
        return turnId;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const retryLast = useCallback(
    async () => (lastPrompt === null ? null : send(lastPrompt)),
    [lastPrompt, send],
  );

  return { send, retryLast, busy, error, lastPrompt };
}
