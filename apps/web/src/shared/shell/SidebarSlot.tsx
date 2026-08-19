/**
 * Sidebar slot of the app shell: a 260 px column with the sidebar surface and a right hairline.
 *
 * Layer: component (shell).
 *
 * Renders its children, or an empty primary navigation landmark until the sidebar feature fills
 * it. The layout owns the grid; this component owns the surface and the landmark.
 */
import type { ReactNode } from 'react';

/** Props of {@link SidebarSlot}. */
export interface SidebarSlotProps {
  /** Sidebar content; an empty `nav` landmark is rendered when omitted. */
  children?: ReactNode;
}

/** 260 px sidebar column. */
export function SidebarSlot({ children }: SidebarSlotProps) {
  return (
    <aside
      className="bg-sidebar text-sidebar-foreground flex h-dvh w-65 flex-col border-r"
      data-testid="sidebar-slot"
    >
      {children ?? <nav aria-label="Primary" className="flex-1" />}
    </aside>
  );
}
