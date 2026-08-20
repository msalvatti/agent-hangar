/**
 * The application sidebar and the global keyboard shortcuts that go with it.
 *
 * Layer: feature (screen).
 *
 * The sidebar takes three shapes: the 260 px column (≥ 1024 px), a 56 px icon rail (768–1023 px)
 * and an overlay drawer (< 768 px). The drawer's trigger is mounted here rather than handed to
 * `PageHeader`'s `navTrigger` slot: pages belong to other features, and importing `features/shell`
 * from them is banned, so the shell owns both the drawer and the button that opens it.
 */
'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { SidebarSlot } from '@/shared/shell/SidebarSlot';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMediaQuery } from '../hooks/useMediaQuery';

import { ChatSearch } from './ChatSearch';
import { MobileNavTrigger } from './MobileNavTrigger';
import { SidebarBody } from './SidebarBody';

/** Viewport at or above which the full 260 px column is shown. */
const FULL_QUERY = '(min-width: 1024px)';

/** Viewport at or above which at least the icon rail is shown. */
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
 * Renders the sidebar in the shape the viewport calls for and wires ⌘K / ⌘N / ⌘,.
 */
export function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  // The drawer records the path it was opened on and is only open while the app is still there.
  // The layout persists across routes, so an open drawer would otherwise survive the navigation it
  // triggered and cover the page it just opened.
  const [drawer, setDrawer] = useState<{ open: boolean; at: string }>({ open: false, at: '' });
  const drawerOpen = drawer.open && drawer.at === pathname;
  // Desktop is the design target (spec 10 §9), so the pre-hydration shape is the full column.
  const isFull = useMediaQuery(FULL_QUERY, true);
  const isRail = useMediaQuery(RAIL_QUERY, true);

  const onSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  const onNewChat = useCallback(() => {
    router.push('/chats/new');
  }, [router]);
  const onSettings = useCallback(() => {
    router.push('/settings');
  }, [router]);
  useKeyboardShortcuts({ onSearch, onNewChat, onSettings });

  const activeId = activeChatId(pathname);
  const search = <ChatSearch open={searchOpen} onOpenChange={setSearchOpen} />;

  if (isFull) {
    return (
      <SidebarSlot>
        <SidebarBody compact={false} activeId={activeId} onOpenSearch={onSearch} />
        {search}
      </SidebarSlot>
    );
  }

  if (isRail) {
    return (
      <aside
        aria-label="Sidebar"
        data-testid="sidebar-rail"
        className="bg-sidebar text-sidebar-foreground flex h-dvh w-14 flex-col border-r"
      >
        <SidebarBody compact activeId={activeId} onOpenSearch={onSearch} />
        {search}
      </aside>
    );
  }

  return (
    <>
      <MobileNavTrigger
        onOpen={() => {
          setDrawer({ open: true, at: pathname });
        }}
      />
      <Sheet
        open={drawerOpen}
        onOpenChange={(open) => {
          setDrawer({ open, at: pathname });
        }}
      >
        <SheetContent side="left" className="bg-sidebar w-65 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
          </SheetHeader>
          <SidebarBody compact={false} activeId={activeId} onOpenSearch={onSearch} />
        </SheetContent>
      </Sheet>
      {search}
    </>
  );
}
