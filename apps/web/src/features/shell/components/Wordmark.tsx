/**
 * Product wordmark at the top of the sidebar, linking home.
 *
 * Layer: feature (component).
 */
import { Hexagon } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/shared/lib/cn';

/** Props of {@link Wordmark}. */
export interface WordmarkProps {
  /** Hides the text, leaving only the mark, for the 56 px icon rail. */
  iconOnly?: boolean;
  className?: string;
}

/**
 * The hexagon mark and, unless collapsed to the rail, the product name.
 *
 * @param props - Icon-only flag and class name.
 */
export function Wordmark({ iconOnly = false, className }: WordmarkProps) {
  return (
    <Link
      href="/chats/new"
      aria-label="Agent Hangar home"
      className={cn(
        'focus-visible:ring-ring flex items-center gap-2 rounded-lg px-2 py-1.5 focus-visible:ring-2 focus-visible:outline-none',
        className,
      )}
    >
      <Hexagon aria-hidden="true" className="text-accent size-5 shrink-0" strokeWidth={1.75} />
      {!iconOnly && <span className="truncate text-sm font-semibold">Agent Hangar</span>}
    </Link>
  );
}
