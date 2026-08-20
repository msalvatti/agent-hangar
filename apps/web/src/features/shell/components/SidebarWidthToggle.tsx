/**
 * Sidebar header control switching between the icon rail and the full column.
 *
 * Layer: feature (component).
 */
'use client';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { Button } from '@/shared/ui/button';

/** Props of {@link SidebarWidthToggle}. */
export interface SidebarWidthToggleProps {
  /** `true` while the sidebar is the icon rail, which the control then expands. */
  compact: boolean;
  onToggle: () => void;
}

/**
 * An icon button naming the shape it moves to, so the name cannot be wrong in either state.
 *
 * @param props - The shape currently rendered and the handler that changes it.
 */
export function SidebarWidthToggle({ compact, onToggle }: SidebarWidthToggleProps) {
  const label = compact ? 'Expand sidebar' : 'Collapse sidebar';
  const Icon = compact ? PanelLeftOpen : PanelLeftClose;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
