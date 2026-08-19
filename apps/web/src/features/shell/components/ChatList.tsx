/**
 * The sidebar's chat sections: active chats and a collapsible archive.
 *
 * Layer: feature (component).
 */
'use client';

import { ChevronRight } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible';
import { Skeleton } from '@/shared/ui/skeleton';

import { useChats } from '../hooks/useChats';
import { readPersisted, subscribePersisted, writePersisted } from '../lib/persisted';

import { ChatRovingList } from './ChatRovingList';

/** `localStorage` key remembering whether the archive is expanded. */
export const ARCHIVED_OPEN_KEY = 'ah-sidebar-archived-open';

/** How many skeleton rows stand in for the list while it loads. */
const SKELETON_ROWS = 5;

/** Shared style of the uppercase section labels. */
const SECTION_LABEL =
  'text-muted-foreground px-2 text-[11px] font-medium tracking-[.06em] uppercase';

/**
 * Reads whether the archive was left expanded.
 *
 * @returns `true` when the stored preference says the group is open.
 */
function readArchivedOpen(): boolean {
  return readPersisted(ARCHIVED_OPEN_KEY) === 'true';
}

/**
 * Server-rendered state of the archive group: collapsed, because storage is not readable there.
 *
 * @returns `false`.
 */
function collapsed(): boolean {
  return false;
}

/** Props of {@link ChatList}. */
export interface ChatListProps {
  /** Id of the chat currently open in the main column, if any. */
  activeId: string | null;
}

/**
 * Renders the CHATS section and the ARCHIVED group, including loading, empty and error states.
 *
 * @param props - The open chat's id.
 */
export function ChatList({ activeId }: ChatListProps) {
  const { active, archived, status, error, refetch } = useChats();
  const archivedOpen = useSyncExternalStore(subscribePersisted, readArchivedOpen, collapsed);

  function toggleArchived(open: boolean): void {
    writePersisted(ARCHIVED_OPEN_KEY, String(open));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
      <h2 className={SECTION_LABEL}>Chats</h2>
      {status === 'loading' && (
        <div className="flex flex-col gap-1" data-testid="chat-list-skeleton">
          {Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      )}
      {status === 'error' && (
        <div className="flex flex-col items-start gap-2 px-2 text-sm">
          <p className="text-destructive">{error?.message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {status === 'success' && active.length === 0 && (
        <p className="text-muted-foreground px-2 text-sm">No chats yet.</p>
      )}
      {status === 'success' && active.length > 0 && (
        <ChatRovingList chats={active} activeId={activeId} label="Chats" />
      )}
      {status === 'success' && archived.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={toggleArchived}>
          <CollapsibleTrigger
            className={cn(
              SECTION_LABEL,
              'hover:text-foreground flex w-full cursor-pointer items-center gap-1 py-1 text-left transition-colors duration-150',
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3 transition-transform duration-150',
                archivedOpen && 'rotate-90',
              )}
            />
            Archived
            <span className="text-muted-foreground ml-auto tabular-nums">{archived.length}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ChatRovingList chats={archived} activeId={activeId} label="Archived chats" />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
