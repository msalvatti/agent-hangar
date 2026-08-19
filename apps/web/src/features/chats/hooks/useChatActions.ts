/**
 * The chat-level actions of the header overflow menu and the archived banner.
 *
 * Layer: feature (hook).
 */
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { invalidateQueries } from '@/shared/api/use-api-query';

import {
  archiveChat,
  cancelTurn,
  deleteChat,
  renameChat,
  restoreChat,
} from '../services/chats-api';

/** Actions that report a busy state. */
export type ChatActionName = 'archive' | 'restore' | 'remove' | 'rename' | 'cancel';

/** Result of {@link useChatActions}. */
export interface UseChatActionsResult {
  archive: () => Promise<void>;
  restore: () => Promise<void>;
  remove: () => Promise<void>;
  rename: (title: string) => Promise<void>;
  cancel: (turnId: string) => Promise<void>;
  copyId: () => Promise<void>;
  /** Which actions are currently in flight. */
  busy: Readonly<Partial<Record<ChatActionName, boolean>>>;
}

/**
 * Wires every chat action to its endpoint, its toast and the query invalidations that follow.
 *
 * @param id - Chat id the actions apply to.
 * @returns The actions and their busy flags.
 */
export function useChatActions(id: string): UseChatActionsResult {
  const router = useRouter();
  const [busy, setBusy] = useState<Partial<Record<ChatActionName, boolean>>>({});

  const run = useCallback(
    async (name: ChatActionName, action: () => Promise<void>, success: string) => {
      setBusy((current) => ({ ...current, [name]: true }));
      try {
        await action();
        invalidateQueries(['chats']);
        invalidateQueries(['chat', id]);
        toast.success(success);
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy((current) => ({ ...current, [name]: false }));
      }
    },
    [id],
  );

  return {
    archive: useCallback(
      () =>
        run(
          'archive',
          async () => {
            await archiveChat(id);
          },
          'Chat archived',
        ),
      [id, run],
    ),
    restore: useCallback(
      () =>
        run(
          'restore',
          async () => {
            await restoreChat(id);
          },
          'Chat restored',
        ),
      [id, run],
    ),
    remove: useCallback(
      () =>
        run(
          'remove',
          async () => {
            await deleteChat(id);
            router.push('/chats/new');
          },
          'Chat deleted',
        ),
      [id, router, run],
    ),
    rename: useCallback(
      (title: string) =>
        run(
          'rename',
          async () => {
            await renameChat(id, title);
          },
          'Chat renamed',
        ),
      [id, run],
    ),
    cancel: useCallback(
      (turnId: string) =>
        run(
          'cancel',
          async () => {
            await cancelTurn(turnId);
          },
          'Turn stopped',
        ),
      [run],
    ),
    copyId: useCallback(async () => {
      await navigator.clipboard.writeText(id);
      toast.success('Chat id copied');
    }, [id]),
    busy,
  };
}
