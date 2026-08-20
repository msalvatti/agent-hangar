/**
 * The chat-level actions of the header overflow menu and the archived banner.
 *
 * Layer: feature (hook).
 *
 * Every action follows the same shape — call the endpoint, refresh the lists that show the chat,
 * confirm with a toast — so they are built from one runner instead of repeating it six times.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { invalidateQueries } from '@/shared/api/use-api-query';
import { maskSecretShapes } from '@/shared/transcript';

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
    async (name: ChatActionName, action: () => Promise<unknown>, success: string) => {
      setBusy((current) => ({ ...current, [name]: true }));
      try {
        await action();
        invalidateQueries(['chats']);
        invalidateQueries(['chat', id]);
        toast.success(success);
      } catch (reason) {
        toast.error(maskSecretShapes(reason instanceof Error ? reason.message : String(reason)));
      } finally {
        setBusy((current) => ({ ...current, [name]: false }));
      }
    },
    [id],
  );

  return useMemo(
    () => ({
      archive: () => run('archive', () => archiveChat(id), 'Chat archived'),
      restore: () => run('restore', () => restoreChat(id), 'Chat restored'),
      remove: () =>
        run(
          'remove',
          async () => {
            await deleteChat(id);
            router.push('/chats/new');
          },
          'Chat deleted',
        ),
      rename: (title: string) => run('rename', () => renameChat(id, title), 'Chat renamed'),
      cancel: (turnId: string) => run('cancel', () => cancelTurn(turnId), 'Turn stopped'),
      copyId: async () => {
        // Callers discard this promise (each action reports through its own toast), so a denied
        // clipboard permission would otherwise surface as an unhandled rejection and no feedback.
        try {
          await navigator.clipboard.writeText(id);
          toast.success('Chat id copied');
        } catch {
          toast.error('Copy failed');
        }
      },
      busy,
    }),
    [busy, id, router, run],
  );
}
