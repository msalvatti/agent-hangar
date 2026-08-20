/**
 * The sidebar's own content: wordmark, search, navigation, chat list and footer.
 *
 * Layer: feature (component).
 */
'use client';

import { Search } from 'lucide-react';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';

import { useShortcutPlatform } from '../hooks/useShortcutPlatform';
import { shortcutHint } from '../lib/shortcuts';

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
  /**
   * Keeps the end of the header row clear for a control the container paints over that corner.
   *
   * The drawer draws its own close button in its top-right corner, on top of whatever the sidebar
   * put there — which is the search button. Two targets on one spot is not a near miss: the one
   * underneath cannot be hit at all.
   */
  headerInset?: boolean;
}

/**
 * Lays the sidebar out top to bottom; the rail variant keeps the same controls without labels.
 *
 * @param props - Compact flag, the open chat's id, the search opener and the header inset.
 */
export function SidebarBody({
  compact,
  activeId,
  onOpenSearch,
  headerInset = false,
}: SidebarBodyProps) {
  const platform = useShortcutPlatform();
  const searchLabel = shortcutHint('Search chats', 'search', platform);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-2">
      <div className={cn('flex items-center justify-between gap-1 px-2', headerInset && 'pr-11')}>
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
