/**
 * Header slot of the app shell: a 48 px bar with a bottom hairline above the page content.
 *
 * Layer: component (shell).
 *
 * Pages render their title, repo chip, status pill and overflow menu inside it.
 */
import type { ReactNode } from 'react';

/** Props of {@link HeaderSlot}. */
export interface HeaderSlotProps {
  /** Header content; the bar renders empty when omitted. */
  children?: ReactNode;
}

/** 48 px page header. */
export function HeaderSlot({ children }: HeaderSlotProps) {
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-3 border-b px-6"
      data-testid="header-slot"
    >
      {children}
    </header>
  );
}
