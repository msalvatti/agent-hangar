/**
 * Creates a chat from the home composer and navigates to it.
 *
 * Layer: feature (hook).
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { invalidateQueries } from '@/shared/api/use-api-query';
import { pushRecentRepo } from '@/shared/repo-picker';

import { createChat } from '../services/chats-api';

/**
 * Key prefix both sidebar lists are registered under, so a new chat appears in the active one.
 *
 * Held here rather than written inside the callback below, whose dependency list carries a
 * directive that would otherwise cover this literal too.
 */
const CHATS_KEY = ['chats'];

/** Input of {@link UseCreateChatResult.create}. */
export interface CreateChatInput {
  /**
   * The repository as the picker reported it. The chat records `url` verbatim rather than a URL
   * rebuilt from `fullName`: which forge a repository lives on is the listing's answer, and a
   * rebuilt URL would silently point every chat at one hard-coded origin.
   */
  repo: RepoSummary;
  /** Branch the workspace is cloned from. */
  branch: string;
  /** The first prompt of the chat. */
  prompt: string;
}

/** Result of {@link useCreateChat}. */
export interface UseCreateChatResult {
  create: (input: CreateChatInput) => Promise<void>;
  /** `true` while the request is in flight; the composer locks on it. */
  busy: boolean;
  /** Message of the last failure, or `undefined`. */
  error: string | undefined;
  /** Clears `error` so the composer can be resubmitted. */
  reset: () => void;
}

/**
 * Posts `POST /api/chats`, then refreshes the sidebar list and navigates to the new chat.
 *
 * @returns The create action and its state.
 */
export function useCreateChat(): UseCreateChatResult {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // The router object Next hands back is stable for the life of the page, and `reset` reads nothing
  // that changes between renders, so both lists are constant — anything added to either would be
  // constant too.
  // Stryker disable ArrayDeclaration
  const create = useCallback(
    async ({ repo, branch, prompt }: CreateChatInput) => {
      setBusy(true);
      setError(undefined);
      try {
        const { chatId } = await createChat({
          repoUrl: repo.url,
          baseBranch: branch,
          prompt,
        });
        pushRecentRepo(repo.fullName);
        invalidateQueries(CHATS_KEY);
        router.push(`/chats/${chatId}`);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const reset = useCallback(() => {
    setError(undefined);
  }, []);
  // Stryker restore ArrayDeclaration

  return { create, busy, error, reset };
}
