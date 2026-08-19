/**
 * The sidebar's own content: wordmark, search, navigation, chat list and footer.
 *
 * Layer: feature (component).
 */
'use client';

import { Search } from 'lucide-react';

import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';

import { shortcutLabel } from '../lib/shortcuts';

import { ChatList } from './ChatList';
import { EnvPill } from './EnvPill';
import { PrimaryNav } from './PrimaryNav';
import { ThemeToggle } from './ThemeToggle';
import { Wordmark } from './Wordmark';

/** Props of {@link SidebarBody}. */
export interface SidebarBodyProps {
  /** Collapses labels and hides the chat list, for the 56 px icon rail. */
  compact: boolean;
  /** Id of the chat open in the main column, if any. */
  activeId: string | null;
  onOpenSearch: () => void;
}

/**
 * Lays the sidebar out top to bottom; the rail variant keeps the same controls without labels.
 *
 * @param props - Compact flag, the open chat's id and the search opener.
 */
export function SidebarBody({ compact, activeId, onOpenSearch }: SidebarBodyProps) {
  const searchLabel = `Search chats (${shortcutLabel('search')})`;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-1 px-2">
        <Wordmark iconOnly={compact} />
        {!compact && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={searchLabel}
            title={searchLabel}
            onClick={onOpenSearch}
            className="cursor-pointer"
          >
            <Search aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </Button>
        )}
      </div>
      <PrimaryNav iconOnly={compact} />
      {compact ? <div className="flex-1" /> : <ChatList activeId={activeId} />}
      <Separator />
      <div className="flex items-center justify-between gap-1 px-2">
        <EnvPill iconOnly={compact} />
        <ThemeToggle />
      </div>
    </div>
  );
}
