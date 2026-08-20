/**
 * Sidebar slot of the app shell: the sidebar surface, as the 260 px column or the 56 px icon rail.
 *
 * Layer: component (shell).
 *
 * The layout owns the grid; this component owns the surface and its width. The navigation landmark
 * belongs to the content: `PrimaryNav` renders the only `nav` labelled "Primary", and a second one
 * here would give the page two navigations with the same accessible name.
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
  compact: boolean;
  /** Sidebar content. */
  children: ReactNode;
}

/**
 * The sidebar column: 260 px wide, or 56 px while compact.
 *
 * @param props - Compact flag and the sidebar content.
 */
export function SidebarSlot({ compact, children }: SidebarSlotProps) {
  return (
    <aside
      aria-label="Sidebar"
      className={cn(
        'bg-sidebar text-sidebar-foreground flex h-dvh flex-col border-r',
        compact ? 'w-14' : 'w-65',
      )}
      data-testid={compact ? 'sidebar-rail' : 'sidebar-slot'}
    >
      {children}
    </aside>
  );
}
