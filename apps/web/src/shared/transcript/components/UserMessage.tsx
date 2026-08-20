/**
 * Renders one user-authored transcript message.
 *
 * Layer: shared (component).
 */
'use client';

import { useLocalTimeZone } from '@/shared/lib/client-only';
import { cn } from '@/shared/lib/cn';

import { formatTimestamp } from '../lib/format';
import { maskSecretShapes } from '../lib/redact-display';

/** Props of {@link UserMessage}. */
export interface UserMessageProps {
  /** Message text, masked for secret shapes and rendered with whitespace preserved. */
  text: string;
  /** ISO timestamp of the prompt, shown as a wall-clock tooltip in the reader's own zone. */
  at?: string;
  className?: string;
}

/**
 * A `--muted` bubble, left-aligned, labelled "You" (spec 10 §4.2). `text` is masked for secret
 * shapes like every other transcript row: a prompt is operator-typed, so a pasted token would
 * otherwise stay on screen for the whole session.
 *
 * The tooltip shows the prompt's local wall-clock time. It appears only once the browser has
 * reported its timezone, which the server cannot know: formatting the instant during the server
 * pass would put a different string in the markup than the one the browser produces, and the
 * hydration React does over that markup would report the two as disagreeing.
 *
 * @param props - The message text, the instant it was sent, and an optional class name.
 */
export function UserMessage({ text, at, className }: UserMessageProps) {
  const timeZone = useLocalTimeZone();
  const sentAt = at === undefined || timeZone === null ? null : formatTimestamp(at, timeZone);
  return (
    <div className={cn('max-w-full', className)} data-item-kind="user" title={sentAt ?? undefined}>
      <div className="text-muted-foreground mb-1 text-[11px] font-medium tracking-[0.06em] uppercase">
        You
      </div>
      <div className="bg-muted w-fit max-w-full rounded-[10px] px-4 py-3 text-[15px] leading-[1.6] whitespace-pre-wrap">
        {maskSecretShapes(text)}
      </div>
    </div>
  );
}
