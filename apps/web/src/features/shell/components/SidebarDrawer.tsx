/**
 * The sidebar as an overlay drawer, for viewports with no room to dock it.
 *
 * Layer: feature (component).
 *
 * The drawer records the path it was opened on and is only open while the app is still there. The
 * layout persists across routes, so an open drawer would otherwise survive the navigation it
 * triggered and cover the page it just opened.
 */
'use client';

import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet';

import { MobileNavTrigger } from './MobileNavTrigger';
import { SidebarBody } from './SidebarBody';

/** Props of {@link SidebarDrawer}. */
export interface SidebarDrawerProps {
  /** Id of the chat open in the main column, if any. */
  activeId: string | null;
  onOpenSearch: () => void;
}

/**
 * The drawer trigger and the overlay it opens.
 *
 * @param props - The open chat's id and the search opener.
 */
export function SidebarDrawer({ activeId, onOpenSearch }: SidebarDrawerProps) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState<{ open: boolean; at: string }>({ open: false, at: '' });
  return (
    <>
      <MobileNavTrigger
        onOpen={() => {
          setDrawer({ open: true, at: pathname });
        }}
      />
      <Sheet
        open={drawer.open && drawer.at === pathname}
        onOpenChange={(open) => {
          setDrawer({ open, at: pathname });
        }}
      >
        <SheetContent side="left" className="bg-sidebar w-65 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
          </SheetHeader>
          <SidebarBody
            compact={false}
            activeId={activeId}
            onOpenSearch={onOpenSearch}
            onToggleWidth={null}
            headerInset
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
