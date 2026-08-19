/**
 * Floating pill that scrolls the transcript back to the latest message.
 *
 * Layer: shared (component).
 */
'use client';

import { ArrowDown } from 'lucide-react';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';

/** Props of {@link JumpToLatest}. */
export interface JumpToLatestProps {
  onClick: () => void;
  className?: string;
}

/** Bottom-centred pill shown while the user has scrolled away from the live edge. */
export function JumpToLatest({ onClick, className }: JumpToLatestProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onClick}
      className={cn(
        'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
        className,
      )}
    >
      <ArrowDown aria-hidden="true" className="size-3.5" />
      Jump to latest
    </Button>
  );
}
