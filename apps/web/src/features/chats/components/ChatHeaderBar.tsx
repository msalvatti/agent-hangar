/**
 * Binds the chat header's buttons to the chat actions.
 *
 * Layer: feature (component).
 *
 * The header takes plain callbacks so it stays testable in isolation; this adapter is where the
 * promises the action hook returns are deliberately not awaited — each one reports its own outcome
 * through a toast.
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';

import type { TurnPhase } from '@/shared/transcript';

import type { UseChatActionsResult } from '../hooks/useChatActions';

import { ChatHeader } from './ChatHeader';

/** Props of {@link ChatHeaderBar}. */
export interface ChatHeaderBarProps {
  chat: ChatSummary;
  phase: TurnPhase;
  startedAt: number | null;
  actions: UseChatActionsResult;
  onStop: () => void;
  onShowError: () => void;
}

/**
 * Renders {@link ChatHeader} wired to the chat's actions.
 *
 * @param props - The chat, the turn's phase, the actions and the two view-owned handlers.
 */
export function ChatHeaderBar({
  chat,
  phase,
  startedAt,
  actions,
  onStop,
  onShowError,
}: ChatHeaderBarProps) {
  return (
    <ChatHeader
      chat={chat}
      phase={phase}
      startedAt={startedAt}
      renaming={actions.busy.rename === true}
      onRename={actions.rename}
      onStop={onStop}
      onShowError={onShowError}
      onArchive={() => {
        void actions.archive();
      }}
      onRestore={() => {
        void actions.restore();
      }}
      onCopyId={() => {
        void actions.copyId();
      }}
      onDelete={() => {
        void actions.remove();
      }}
    />
  );
}
