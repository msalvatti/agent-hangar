/**
 * Button that opens the sidebar drawer on narrow viewports.
 *
 * Layer: feature (component).
 */
'use client';

import { Menu } from 'lucide-react';

import { Button } from '@/shared/ui/button';

/** Props of {@link MobileNavTrigger}. */
export interface MobileNavTriggerProps {
  onOpen: () => void;
}

/**
 * A fixed top-left button; the shell mounts it only while the drawer layout is active, so pages
 * never have to know about it.
 *
 * @param props - Handler that opens the drawer.
 */
export function MobileNavTrigger({ onOpen }: MobileNavTriggerProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Open navigation"
      title="Open navigation"
      onClick={onOpen}
      className="fixed top-2 left-2 z-40 cursor-pointer"
    >
      <Menu aria-hidden="true" className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
