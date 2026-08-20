/**
 * Blinking block cursor appended after streaming assistant text.
 *
 * Layer: shared (component).
 */
import { cn } from '@/shared/lib/cn';

/** Props of {@link StreamCursor}. */
export interface StreamCursorProps {
  className?: string;
}

/** The `▍` cursor: an opacity-pulsing 2 px block, decorative only. */
export function StreamCursor({ className }: StreamCursorProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="stream-cursor"
      className={cn(
        'bg-foreground ml-0.5 inline-block h-[1em] w-0.5 animate-pulse align-middle motion-reduce:animate-none',
        className,
      )}
    />
  );
}
