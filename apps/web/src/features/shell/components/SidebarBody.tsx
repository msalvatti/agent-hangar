/**
 * The sidebar's own content: wordmark, search, navigation, chat list and footer.
 *
 * Layer: feature (component).
 *
 * The header and footer rows lay their controls out side by side in the 260 px column and stacked
 * in the 56 px rail. The rail leaves 40 px between its horizontal padding, which is narrower than
 * two icon controls plus the gap between them, so side by side there is not a tight fit but an
 * overflow: the trailing control is painted outside the sidebar's own border.
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
import { SidebarWidthToggle } from './SidebarWidthToggle';
import { ThemeToggle } from './ThemeToggle';
import { Wordmark } from './Wordmark';

/** How a header or footer row arranges its controls in each shape. */
const ROW_LAYOUT = {
  wide: 'items-center justify-between',
  rail: 'flex-col items-center',
} as const;

/** Props of {@link SidebarBody}. */
export interface SidebarBodyProps {
  /** Collapses labels and hides the chat list, for the 56 px icon rail. */
  compact: boolean;
  /** Id of the chat open in the main column, if any. */
  activeId: string | null;
  onOpenSearch: () => void;
  /**
   * Switches between the rail and the full column, or `null` in the drawer.
   *
   * The drawer is the only shape a viewport under 768 px has room for, so there is nothing for the
   * control to switch to there and it is left out rather than rendered inert.
   */
  onToggleWidth: (() => void) | null;
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
 * @param props - Compact flag, the open chat's id, the search opener, the width toggle and the
 *   header inset.
 */
export function SidebarBody({
  compact,
  activeId,
  onOpenSearch,
  onToggleWidth,
  headerInset = false,
}: SidebarBodyProps) {
  const platform = useShortcutPlatform();
  const searchLabel = shortcutHint('Search chats', 'search', platform);
  const rowLayout = compact ? ROW_LAYOUT.rail : ROW_LAYOUT.wide;
  const widthToggle =
    onToggleWidth === null ? null : (
      <SidebarWidthToggle compact={compact} onToggle={onToggleWidth} />
    );
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 py-2">
      <div className={cn('flex gap-1 px-2', rowLayout, headerInset && 'pr-11')}>
        <Wordmark iconOnly={compact} />
        <div className="flex items-center gap-1">
          {widthToggle}
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
      </div>
      <PrimaryNav iconOnly={compact} />
      {compact ? <div className="flex-1" /> : <ChatList activeId={activeId} />}
      <Separator />
      <div className={cn('flex gap-1 px-2', rowLayout)}>
        <EnvPill iconOnly={compact} />
        <ThemeToggle />
      </div>
    </div>
  );
}
