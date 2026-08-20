/**
 * Decorative product mark shown above the home headline.
 *
 * Layer: feature (component).
 */
import { Hexagon } from 'lucide-react';

import { cn } from '@/shared/lib/cn';

/** Props of {@link LogoMark}. */
export interface LogoMarkProps {
  className?: string;
}

/**
 * A 48 px muted square holding the 40 px accent hexagon. Purely decorative: the headline below
 * carries the meaning, so the mark is hidden from assistive technology.
 *
 * @param props - Optional class name.
 */
export function LogoMark({ className }: LogoMarkProps) {
  return (
    <div
      aria-hidden="true"
      data-testid="logo-mark"
      className={cn('bg-muted flex size-12 items-center justify-center rounded-[10px]', className)}
    >
      <Hexagon className="text-accent size-10" strokeWidth={1.75} />
    </div>
  );
}
