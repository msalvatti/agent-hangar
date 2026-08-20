/**
 * Header row of the chat page: title, repository, turn status and the actions.
 *
 * Layer: feature (component).
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';
import { Square } from 'lucide-react';

import { PageHeader } from '@/shared/shell/PageHeader';
import { StatusPill } from '@/shared/transcript';
import type { TurnPhase } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';

import { ChatMenu } from './ChatMenu';
import { ChatTitle } from './ChatTitle';
import { RepoChip } from './RepoChip';

/** Phases during which the turn can still be stopped. */
const STOPPABLE: ReadonlySet<TurnPhase> = new Set<TurnPhase>(['queued', 'preparing', 'running']);

/** Props of {@link ChatHeader}. */
export interface ChatHeaderProps {
  chat: ChatSummary;
  phase: TurnPhase;
  startedAt: number | null;
  renaming: boolean;
  onRename: (title: string) => Promise<void>;
  onStop: () => void;
  /** Called when the failed pill is clicked, to scroll the error into view. */
  onShowError: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onCopyId: () => void;
  onDelete: () => void;
}

/**
 * Composes the chat's header inside the shared `PageHeader`.
 *
 * @param props - The chat, the turn's phase and every header action.
 */
export function ChatHeader({
  chat,
  phase,
  startedAt,
  renaming,
  onRename,
  onStop,
  onShowError,
  onArchive,
  onRestore,
  onCopyId,
  onDelete,
}: ChatHeaderProps) {
  const archived = chat.status === 'ARCHIVED';
  return (
    <PageHeader
      title={
        <ChatTitle title={chat.title} editable={!archived} onRename={onRename} busy={renaming} />
      }
      actions={
        <>
          <RepoChip
            repoUrl={chat.repoUrl}
            baseBranch={chat.baseBranch}
            workBranch={chat.workBranch}
          />
          <StatusPill
            phase={phase}
            startedAt={startedAt}
            {...(phase === 'failed' ? { onClick: onShowError } : {})}
          />
          {STOPPABLE.has(phase) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStop}
              className="cursor-pointer"
            >
              <Square aria-hidden="true" className="size-3.5" />
              Stop
            </Button>
          )}
          <ChatMenu
            archived={archived}
            onArchive={onArchive}
            onRestore={onRestore}
            onCopyId={onCopyId}
            onDelete={onDelete}
          />
        </>
      }
    />
  );
}
