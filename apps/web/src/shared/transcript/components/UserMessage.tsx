/**
 * Renders one user-authored transcript message.
 *
 * Layer: shared (component).
 */
import { cn } from '@/shared/lib/cn';

import { maskSecretShapes } from '../lib/redact-display';

/** Props of {@link UserMessage}. */
export interface UserMessageProps {
  /** Message text, masked for secret shapes and rendered with whitespace preserved. */
  text: string;
  /** ISO timestamp, currently unused visually but accepted for future display. */
  at?: string;
  className?: string;
}

/**
 * A `--muted` bubble, left-aligned, labelled "You" (spec 10 §4.2). `text` is masked for secret
 * shapes like every other transcript row: a prompt is operator-typed, so a pasted token would
 * otherwise stay on screen for the whole session.
 */
export function UserMessage({ text, at, className }: UserMessageProps) {
  return (
    <div className={cn('max-w-full', className)} data-item-kind="user" title={at}>
      <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.06em] uppercase">
        You
      </div>
      <div className="bg-muted w-fit max-w-full rounded-[10px] px-4 py-3 text-[15px] leading-[1.6] whitespace-pre-wrap">
        {maskSecretShapes(text)}
      </div>
    </div>
  );
}
