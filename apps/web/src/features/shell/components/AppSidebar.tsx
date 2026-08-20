/**
 * The application sidebar and the global keyboard shortcuts that go with it.
 *
 * Layer: feature (screen).
 *
 * The sidebar takes three shapes: the 260 px column, a 56 px icon rail and an overlay drawer.
 * Under 768 px the drawer is the only one that fits, so the viewport decides alone. At or above
 * 768 px the viewport only supplies the default — the column from 1024 px, the rail below it —
 * and a stored choice overrides it in either direction, because a screen that cannot be widened
 * would otherwise leave no way out of the rail.
 *
 * The drawer is mounted here rather than handed to `PageHeader`'s `navTrigger` slot: pages belong
 * to other features, and importing `features/shell` from them is banned, so the shell owns both
 * the drawer and the button that opens it.
 */
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { SidebarSlot } from '@/shared/shell/SidebarSlot';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { railShape, useSidebarWidth } from '../hooks/useSidebarWidth';

import { ChatSearch } from './ChatSearch';
import { SidebarBody } from './SidebarBody';
import { SidebarDrawer } from './SidebarDrawer';

/** Viewport at or above which the full 260 px column is the default shape. */
const FULL_QUERY = '(min-width: 1024px)';

/** Viewport at or above which the sidebar is docked at all, rather than living in the drawer. */
const RAIL_QUERY = '(min-width: 768px)';

/**
 * Reads the open chat's id out of the current path.
 *
 * @param pathname - The current path.
 * @returns The chat id, or `null` when no chat is open.
 */
function activeChatId(pathname: string): string | null {
  const id = /^\/chats\/([^/]+)$/.exec(pathname)?.[1];
  return id === undefined || id === 'new' ? null : id;
}

/**
 * Renders the sidebar in the shape the viewport and the stored choice call for, and wires ⌘K / ⌘N
 * / ⌘,.
 */
export function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  // Desktop is the design target (spec 10 §9), so the pre-hydration shape is the full column.
  const isFull = useMediaQuery(FULL_QUERY, true);
  const isDocked = useMediaQuery(RAIL_QUERY, true);
  const { width, setWidth } = useSidebarWidth();
  const compact = railShape(width, isFull);

  const onSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  const onNewChat = useCallback(() => {
    router.push('/chats/new');
  }, [router]);
  const onSettings = useCallback(() => {
    router.push('/settings');
  }, [router]);
  const onToggleWidth = useCallback(() => {
    setWidth(compact ? 'column' : 'rail');
  }, [compact, setWidth]);
  useKeyboardShortcuts({ onSearch, onNewChat, onSettings });

  const activeId = activeChatId(pathname);
  const search = <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />;

  if (isDocked) {
    return (
      <SidebarSlot compact={compact}>
        <SidebarBody
          compact={compact}
          activeId={activeId}
          onOpenSearch={onSearch}
          onToggleWidth={onToggleWidth}
        />
        {search}
      </SidebarSlot>
    );
  }

  return (
    <>
      <SidebarDrawer activeId={activeId} onOpenSearch={onSearch} />
      {search}
    </>
  );
}
