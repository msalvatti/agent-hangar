/**
 * Sidebar slot of the app shell: the sidebar surface, as the 260 px column or the 56 px icon rail.
 *
 * Layer: component (shell).
 *
 * Renders its children, or an empty primary navigation landmark until the sidebar feature fills
 * it. The layout owns the grid; this component owns the surface and the landmark.
 *
 * One element takes both widths rather than one element per width. Swapping between two elements
 * would unmount whatever control was just used, and someone who collapses the sidebar from the
 * keyboard would find the focus back at the top of the document instead of on the control they
 * pressed.
 */
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

/** Props of {@link SidebarSlot}. */
export interface SidebarSlotProps {
  /** Renders the 56 px icon rail instead of the 260 px column. */
  compact?: boolean;
  /** Sidebar content; an empty `nav` landmark is rendered when omitted. */
  children?: ReactNode;
}

/**
 * The sidebar column: 260 px wide, or 56 px while compact.
 *
 * @param props - Compact flag and the sidebar content.
 */
export function SidebarSlot({ compact = false, children }: SidebarSlotProps) {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        'bg-sidebar text-sidebar-foreground flex h-dvh flex-col border-r',
        compact ? 'w-14' : 'w-65',
      )}
      data-testid={compact ? 'sidebar-rail' : 'sidebar-slot'}
    >
      {children ?? <nav aria-label="Primary" className="flex-1" />}
    </aside>
  );
}
